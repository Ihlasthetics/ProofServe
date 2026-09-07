import { expect, expectTypeOf, it } from 'vitest';
import {
  AgentTaskSchema,
  agentTaskFixture,
  type AgentTask,
} from '@proofserve/shared';

it('resolves runtime exports and types through the prepared public package', () => {
  const task = AgentTaskSchema.parse(agentTaskFixture);

  expectTypeOf(task).toEqualTypeOf<AgentTask>();
  expect(task).toEqual(agentTaskFixture);
});
