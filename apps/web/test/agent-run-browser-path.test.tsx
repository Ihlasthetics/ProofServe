import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentRunDemo } from '../src/components/agent-run-demo';
import { agentRun, agentTask } from './agent-run-fixtures';

const access = 'test-demo-access-code';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

class TestEvent {
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  defaultPrevented = false;
  target: TestNode | null = null;
  currentTarget: TestNode | null = null;
  cancelBubble = false;
  returnValue = true;

  constructor(
    readonly type: string,
    init: { bubbles?: boolean; cancelable?: boolean } = {},
  ) {
    this.bubbles = init.bubbles ?? false;
    this.cancelable = init.cancelable ?? false;
  }

  preventDefault() {
    if (this.cancelable) {
      this.defaultPrevented = true;
      this.returnValue = false;
    }
  }

  stopPropagation() {
    this.cancelBubble = true;
  }
}

type TestListener = (event: TestEvent) => void;

class TestNode {
  static readonly ELEMENT_NODE = 1;
  static readonly TEXT_NODE = 3;
  static readonly COMMENT_NODE = 8;
  static readonly DOCUMENT_NODE = 9;

  parentNode: TestNode | null = null;
  readonly childNodes: TestNode[] = [];
  readonly listeners = new Map<
    string,
    { listener: TestListener; capture: boolean }[]
  >();
  nodeValue: string | null = null;

  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    readonly ownerDocument: TestDocument | null,
  ) {}

  get firstChild(): TestNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): TestNode | null {
    return this.childNodes.at(-1) ?? null;
  }

  get nextSibling(): TestNode | null {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[index + 1] ?? null;
  }

  get textContent(): string {
    if (this.nodeType === TestNode.TEXT_NODE) return this.nodeValue ?? '';
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.childNodes.splice(0);
    if (value !== '') this.appendChild(this.document.createTextNode(value));
  }

  get document(): TestDocument {
    if (this instanceof TestDocument) return this;
    if (!this.ownerDocument) throw new Error('Node has no owner document');
    return this.ownerDocument;
  }

  appendChild<T extends TestNode>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore<T extends TestNode>(child: T, before: TestNode | null): T {
    if (before === null) return this.appendChild(child);
    const index = this.childNodes.indexOf(before);
    if (index < 0) throw new Error('Reference node is not a child');
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.splice(index, 0, child);
    return child;
  }

  removeChild<T extends TestNode>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index < 0) throw new Error('Node is not a child');
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  addEventListener(
    type: string,
    listener: TestListener,
    options?: boolean | { capture?: boolean },
  ) {
    const capture =
      typeof options === 'boolean' ? options : (options?.capture ?? false);
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ listener, capture });
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: TestListener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter(
        (registered) => registered.listener !== listener,
      ),
    );
  }

  dispatchEvent(event: TestEvent) {
    if (!event.target) event.target = this;
    const path: TestNode[] = [this];
    for (let node = this.parentNode; node; node = node.parentNode)
      path.push(node);
    for (const node of [...path].reverse()) {
      node.invokeListeners(event, true);
      if (event.cancelBubble) return !event.defaultPrevented;
    }
    for (const node of path) {
      node.invokeListeners(event, false);
      if (event.cancelBubble || !event.bubbles) break;
    }
    return !event.defaultPrevented;
  }

  private invokeListeners(event: TestEvent, capture: boolean) {
    event.currentTarget = this;
    for (const registered of this.listeners.get(event.type) ?? [])
      if (registered.capture === capture) registered.listener(event);
  }
}

class TestElement extends TestNode {
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml';
  value = '';
  checked = false;
  disabled = false;
  name = '';
  type = '';

  constructor(
    readonly tagName: string,
    ownerDocument: TestDocument,
  ) {
    super(TestNode.ELEMENT_NODE, tagName.toUpperCase(), ownerDocument);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
    if (name === 'name') this.name = String(value);
    if (name === 'type') this.type = String(value);
    if (name === 'disabled') this.disabled = true;
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
    if (name === 'disabled') this.disabled = false;
  }

  getRootNode() {
    let root = this.parentNode;
    if (!root) return this;
    while (root.parentNode) root = root.parentNode;
    return root;
  }
}

class TestDocument extends TestNode {
  readonly documentElement: TestElement;
  readonly body: TestElement;
  readonly defaultView: Record<string, unknown>;
  activeElement: TestElement | null = null;

  constructor() {
    super(TestNode.DOCUMENT_NODE, '#document', null);
    this.defaultView = {};
    this.documentElement = this.createElement('html');
    this.body = this.createElement('body');
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
  }

  createElement(tagName: string) {
    return new TestElement(tagName.toLowerCase(), this);
  }

  createElementNS(_namespace: string, tagName: string) {
    return this.createElement(tagName);
  }

  createTextNode(value: string) {
    const node = new TestNode(TestNode.TEXT_NODE, '#text', this);
    node.nodeValue = value;
    return node;
  }

  createComment(value: string) {
    const node = new TestNode(TestNode.COMMENT_NODE, '#comment', this);
    node.nodeValue = value;
    return node;
  }
}

class TestFormData {
  readonly values = new Map<string, string>();

  constructor(form?: unknown) {
    if (!(form instanceof TestElement) || form.tagName !== 'form')
      throw new TypeError('Expected a mounted form');
    visit(form, (element) => {
      if (element.name) this.values.set(element.name, element.value);
    });
  }

  get(name: string) {
    return this.values.get(name) ?? null;
  }
}

function visit(node: TestNode, callback: (element: TestElement) => void) {
  if (node instanceof TestElement) callback(node);
  for (const child of node.childNodes) visit(child, callback);
}

function findElement(
  root: TestNode,
  predicate: (element: TestElement) => boolean,
): TestElement {
  const result = findMatchingElement(root, predicate);
  if (!result) throw new Error('Expected mounted element was not found');
  return result;
}

function findMatchingElement(
  node: TestNode,
  predicate: (element: TestElement) => boolean,
): TestElement | null {
  if (node instanceof TestElement && predicate(node)) return node;
  for (const child of node.childNodes) {
    const result = findMatchingElement(child, predicate);
    if (result) return result;
  }
  return null;
}

let mountedRoot: { unmount(): void } | null = null;

beforeEach(() => {
  const document = new TestDocument();
  const window = document.defaultView;
  Object.assign(window, {
    document,
    Node: TestNode,
    Element: TestElement,
    HTMLElement: TestElement,
    HTMLIFrameElement: class extends TestElement {},
    Event: TestEvent,
    MouseEvent: TestEvent,
    FormData: TestFormData,
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (...args: Parameters<typeof clearTimeout>) =>
      clearTimeout(...args),
    getSelection: () => null,
  });
  document.defaultView.window = window;
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  vi.stubGlobal('Node', TestNode);
  vi.stubGlobal('Element', TestElement);
  vi.stubGlobal('HTMLElement', TestElement);
  vi.stubGlobal('HTMLIFrameElement', window.HTMLIFrameElement);
  vi.stubGlobal('Event', TestEvent);
  vi.stubGlobal('MouseEvent', TestEvent);
  vi.stubGlobal('FormData', TestFormData);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(async () => {
  if (mountedRoot) {
    await act(async () => mountedRoot?.unmount());
    mountedRoot = null;
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mountDemo(fetcher: ReturnType<typeof vi.fn<typeof fetch>>) {
  vi.stubGlobal('fetch', fetcher);
  const { createRoot } = await import('react-dom/client');
  const container = document.createElement('div') as unknown as TestElement;
  (document.body as unknown as TestElement).appendChild(container);
  const root = createRoot(container as unknown as HTMLElement);
  mountedRoot = root;
  await act(async () => root.render(<AgentRunDemo />));

  const form = findElement(container, (element) => element.tagName === 'form');
  const accessInput = findElement(
    form,
    (element) => element.name === 'accessToken',
  );
  const ticketInput = findElement(form, (element) => element.name === 'ticket');
  const budgetInput = findElement(
    form,
    (element) => element.name === 'maxAmountAtomic',
  );
  const submit = findElement(
    form,
    (element) => element.tagName === 'button' && element.type === 'submit',
  );
  const fieldset = findElement(
    form,
    (element) => element.tagName === 'fieldset',
  );

  async function enter(element: TestElement, value: string) {
    await act(async () => {
      element.value = value;
      element.dispatchEvent(new TestEvent('input', { bubbles: true }));
      element.dispatchEvent(new TestEvent('change', { bubbles: true }));
    });
  }

  async function submitForm() {
    expect(submit.disabled).toBe(false);
    await act(async () => {
      form.dispatchEvent(
        new TestEvent('submit', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
  }

  await enter(accessInput, access);
  await enter(ticketInput, agentTask.input.ticket);
  await enter(budgetInput, agentTask.budget.maxAmountAtomic);
  return { container, fieldset, form, submitForm };
}

async function advancePollingTimer() {
  await act(async () => {
    await vi.advanceTimersToNextTimerAsync();
    await Promise.resolve();
  });
}

it('mounts AgentRunDemo, submits its controls once, and polls authoritative stages to completion', async () => {
  vi.useFakeTimers();
  const snapshots = [
    agentRun('DISCOVERING'),
    agentRun('SELECTED'),
    agentRun('PAYMENT_REQUIRED'),
    agentRun('PAYING'),
    agentRun('PAID'),
    agentRun('EXECUTING'),
    agentRun('COMPLETED'),
  ];
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json(agentRun(), 202));
  for (const snapshot of snapshots)
    fetcher.mockResolvedValueOnce(json(snapshot));
  const { container, submitForm } = await mountDemo(fetcher);

  expect(container.textContent).toContain(
    'This is not a wallet or signing key, but it authorizes demo runs that may spend testnet HBAR.',
  );
  await submitForm();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/agent/runs');
  expect(fetcher.mock.calls[0]?.[1]?.method).toBe('POST');
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual(
    agentTask,
  );

  for (const [index, evidence] of [
    'Discovering eligible services',
    'Selected service:',
    'HTTP 402 · Payment required',
    'Signing and submitting payment',
    'Payment receipt',
    'AI service executing',
    'AI result',
  ].entries()) {
    await advancePollingTimer();
    expect(fetcher.mock.calls[index + 1]?.[1]?.method).toBe('GET');
    expect(container.textContent).toContain(evidence);
  }

  expect(container.textContent).toContain('Settlement confirmed');
  expect(container.textContent).toContain('Possible duplicate payment');
  expect(container.textContent).toContain('receipt_live_123');
  const hashScan = findElement(
    container,
    (element) =>
      element.tagName === 'a' && element.textContent.includes('HashScan'),
  );
  expect(hashScan.getAttribute('href')).toBe(
    'https://hashscan.io/testnet/transaction/0.0.7162784-1788940800-123456789',
  );
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(fetcher).toHaveBeenCalledTimes(8);
  expect(
    fetcher.mock.calls.filter((call) => call[1]?.method === 'POST'),
  ).toHaveLength(1);
});

it('locks the mounted form against repeated submission while creation is pending', async () => {
  let resolveCreation!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        resolveCreation = resolve;
      }),
  );
  const { container, fieldset, form, submitForm } = await mountDemo(fetcher);
  await submitForm();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(fieldset.disabled).toBe(true);
  expect(container.textContent).toContain('Do not resubmit');
  await act(async () => {
    form.dispatchEvent(
      new TestEvent('submit', { bubbles: true, cancelable: true }),
    );
  });
  expect(fetcher).toHaveBeenCalledOnce();
  resolveCreation(json(agentRun(), 202));
  await act(async () => Promise.resolve());
});

it.each([
  [
    'failed response',
    () =>
      json(
        { error: { code: 'INTERNAL_ERROR', message: 'backend failed' } },
        500,
      ),
  ],
  ['transport uncertainty', () => Promise.reject(new Error('offline'))],
] as const)(
  'locks the mounted form after %s and prevents a second POST',
  async (_scenario, outcome) => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => outcome());
    const { container, fieldset, form, submitForm } = await mountDemo(fetcher);
    await submitForm();
    expect(container.textContent).toContain('do not resubmit');
    expect(fieldset.disabled).toBe(true);
    await act(async () => {
      form.dispatchEvent(
        new TestEvent('submit', { bubbles: true, cancelable: true }),
      );
      await vi.runAllTimersAsync();
    });
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
