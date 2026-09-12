import { randomUUID } from 'node:crypto';
import {
  AgentRunSchema,
  PaymentReceiptSchema,
  TimestampSchema,
  type AgentRun,
  type AgentTask,
  type Identifier,
} from '@proofserve/shared';
import {
  BuyerError,
  createBuyerRun,
  validateBuyerConfiguration,
  type BuyerOptions,
  type BuyerOwnership,
} from '@proofserve/agent';
import type { AgentRunRepository } from './agent-run-repository.js';
import {
  createHederaSettlementReconciler,
  type SettlementReconciler,
} from './hedera-settlement-reconciler.js';

export class AgentRunServiceError extends Error {
  constructor(readonly code: 'RUN_NOT_FOUND') {
    super('Agent run not found.');
    this.name = 'AgentRunServiceError';
  }
}

export interface AgentRunServiceOptions {
  repository: AgentRunRepository;
  buyer: Omit<BuyerOptions, 'runId' | 'ownership'>;
  now?: () => string;
  runId?: () => Identifier;
  ownerId?: () => Identifier;
  schedule?: (work: () => void) => void;
  createBuyer?: typeof createBuyerRun;
  settlementReconciler?: SettlementReconciler;
}

export interface AgentRunService {
  createRun(task: AgentTask): Promise<AgentRun>;
  getRun(runId: Identifier): Promise<AgentRun>;
  reconcile(): Promise<void>;
  executeRun(runId: Identifier): Promise<void>;
}

export function createAgentRunService(
  options: AgentRunServiceOptions,
): AgentRunService {
  const repository = options.repository;
  const clock = options.now ?? (() => new Date().toISOString());
  const nextRunId = options.runId ?? randomUUID;
  const nextOwnerId = options.ownerId ?? randomUUID;
  const schedule = options.schedule ?? ((work) => setImmediate(work));
  const createBuyer = options.createBuyer ?? createBuyerRun;
  const settlementReconciler =
    options.settlementReconciler ?? createHederaSettlementReconciler();
  const buyerConfiguration = validateBuyerConfiguration(options.buyer);
  const buyerOptions: Omit<BuyerOptions, 'runId' | 'ownership'> = {
    ...options.buyer,
    ...buyerConfiguration,
  };
  const locallyScheduled = new Set<Identifier>();
  const reconciliationQueued = new Set<Identifier>();

  const scheduleRun = (runId: Identifier) => {
    if (locallyScheduled.has(runId)) {
      reconciliationQueued.add(runId);
      return;
    }
    locallyScheduled.add(runId);
    schedule(() => {
      const finished = () => {
        locallyScheduled.delete(runId);
        if (reconciliationQueued.delete(runId)) scheduleRun(runId);
      };
      void service.executeRun(runId).then(finished, finished);
    });
  };

  const service: AgentRunService = {
    async createRun(task) {
      const now = TimestampSchema.parse(clock());
      const id = nextRunId();
      const snapshot = AgentRunSchema.parse({
        id,
        task,
        status: 'CREATED',
        selectedServiceId: null,
        paymentRequirements: null,
        paymentReceipt: null,
        result: null,
        error: null,
        events: [{ status: 'CREATED', occurredAt: now }],
        createdAt: now,
        updatedAt: now,
      });
      await repository.createRun(snapshot);
      scheduleRun(id);
      return AgentRunSchema.parse(snapshot);
    },

    async getRun(runId) {
      const snapshot = await repository.getRun(runId);
      if (!snapshot) throw new AgentRunServiceError('RUN_NOT_FOUND');
      return AgentRunSchema.parse(snapshot);
    },

    async reconcile() {
      for (const runId of await repository.listReconciliationRunIds())
        scheduleRun(runId);
    },

    async executeRun(runId) {
      try {
        const stored = await repository.getRun(runId);
        if (
          !stored ||
          stored.status === 'COMPLETED' ||
          stored.status === 'FAILED'
        )
          return;
        const recoveryTime = TimestampSchema.parse(clock());
        if (await repository.reconcileTombstonedRun(runId, recoveryTime))
          return;
        const attempt = await repository.getPaymentReconciliation(runId);
        if (attempt) {
          const resolution = await settlementReconciler.reconcile(attempt);
          if (resolution.status === 'CONFIRMED') {
            if (
              !stored.selectedServiceId ||
              !stored.paymentRequirements ||
              stored.paymentRequirements.payTo !== attempt.receiver ||
              stored.paymentRequirements.amountAtomic !==
                attempt.amountAtomic ||
              stored.paymentRequirements.asset !== attempt.asset ||
              stored.paymentRequirements.network !== attempt.network
            )
              return;
            const eventTime = TimestampSchema.parse(
              resolution.settledAt < stored.updatedAt
                ? stored.updatedAt
                : resolution.settledAt,
            );
            const receipt = PaymentReceiptSchema.parse({
              id: randomUUID(),
              runId,
              serviceId: stored.selectedServiceId,
              paymentRequirements: stored.paymentRequirements,
              transactionId: attempt.transactionId,
              transactionUrl: resolution.transactionUrl,
              settledAt: resolution.settledAt,
            });
            await repository.recoverConfirmedPayment(
              runId,
              attempt,
              receipt,
              eventTime,
            );
          } else if (
            resolution.status === 'ABSENT' ||
            resolution.status === 'REJECTED'
          ) {
            await repository.failExpiredPayment(
              runId,
              attempt.transactionId,
              recoveryTime,
            );
          }
          return;
        }
        const ownerId = nextOwnerId();
        const ownership: BuyerOwnership = {
          claim: async (requestedRunId) => {
            if (requestedRunId !== runId)
              throw new BuyerError('VALIDATION_ERROR');
            const claim = await repository.claimExecution(runId, ownerId);
            if (!claim) throw new BuyerError('VALIDATION_ERROR');
            return {
              initialRun: claim.snapshot,
              persist: (snapshot) => claim.persist(snapshot),
              beginSigning: (expectation) => claim.beginSigning(expectation),
              recordPaymentAttempt: (attempt) =>
                claim.recordPaymentAttempt(attempt),
              authorizeSubmission: (transactionId) =>
                claim.authorizeSubmission(transactionId),
              release: () => claim.release(),
            };
          },
        };
        const outcome = await createBuyer(stored.task, {
          ...buyerOptions,
          runId,
          ownership,
        }).execute();
        if (outcome.status === 'PAYING' && outcome.paymentReceipt === null) {
          const recoveryTime = TimestampSchema.parse(clock());
          if (await repository.reconcileTombstonedRun(runId, recoveryTime))
            return;
          if (await repository.getPaymentReconciliation(runId))
            scheduleRun(runId);
        }
      } catch {
        try {
          const recoveryTime = TimestampSchema.parse(clock());
          if (await repository.reconcileTombstonedRun(runId, recoveryTime))
            return;
          await repository.failUnclaimedRun(runId, recoveryTime);
        } catch {
          // A later reconciliation retries; raw errors are never serialized.
        }
      }
    },
  };
  return service;
}
