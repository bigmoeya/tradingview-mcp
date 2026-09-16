import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensurePineEditorOpen,
  getSource,
  setSource,
} from '../src/core/pine.js';
import {
  CLOSE_PINE_EDITOR_EXPRESSION,
  OPEN_PINE_EDITOR_EXPRESSION,
  RESOLVE_PINE_EDITOR,
  ensurePineEditorOpenDetailed,
  runPineEditorOperation,
} from '../src/core/pine-editor.js';
import { openPanel } from '../src/core/ui.js';

class FakeNode {
  constructor({ className = '', tagName = 'DIV', visible = true, connected = true, attributes = {} } = {}) {
    this.className = className;
    this.tagName = tagName;
    this.visible = visible;
    this.isConnected = connected;
    this.attributes = attributes;
    this.parentElement = null;
    this.clicked = 0;
    this.titleNode = null;
    this.queryNodes = [];
  }

  appendTo(parent) {
    this.parentElement = parent;
    return this;
  }

  contains(node) {
    for (let current = node; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  getBoundingClientRect() {
    return this.visible ? { width: 800, height: 400 } : { width: 0, height: 0 };
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  querySelector() {
    return this.titleNode;
  }

  querySelectorAll() {
    return this.queryNodes;
  }

  click() {
    this.clicked++;
  }
}

function fakeStyle(node) {
  return {
    display: node.visible ? 'block' : 'none',
    visibility: node.visible ? 'visible' : 'hidden',
    opacity: node.visible ? '1' : '0',
  };
}

function fakeDocument({ containers = [], uiNodes = [], controls = [] } = {}) {
  return {
    documentElement: {
      contains(node) { return !!node?.isConnected; },
    },
    querySelectorAll(selector) {
      if (selector === '.monaco-editor.pine-editor-monaco') return containers;
      if (selector.includes('[role="dialog"]')) return uiNodes;
      if (selector.includes('[aria-label="Pine"]')) return controls;
      return [];
    },
  };
}

function editorFor(domNode, {
  model = { uri: { toString: () => 'pine://current' }, isDisposed: () => false },
  value = 'source',
  disposed = false,
} = {}) {
  return {
    getDomNode: () => domNode,
    getModel: () => model,
    getValue: () => value,
    isDisposed: () => disposed,
  };
}

function environment(editors) {
  return {
    editor: {
      getEditors: () => editors,
      getModelMarkers: () => [],
    },
  };
}

function attachEnvironment(node, env, { depth = 0, alternate = false } = {}) {
  let tail = { memoizedProps: { value: { monacoEnv: env } }, return: null, alternate: null };
  for (let index = 0; index < depth; index++) {
    tail = { memoizedProps: {}, return: tail, alternate: null };
  }
  if (alternate) {
    node.__reactFiber$test = { memoizedProps: {}, return: null, alternate: tail };
  } else {
    node.__reactFiber$test = tail;
  }
}

function runResolver(document) {
  return Function(
    'document',
    'getComputedStyle',
    `return (${RESOLVE_PINE_EDITOR});`
  )(document, fakeStyle);
}

function runOpenAction(document, window) {
  return Function(
    'document',
    'getComputedStyle',
    'window',
    `return (${OPEN_PINE_EDITOR_EXPRESSION});`
  )(document, fakeStyle, window);
}

function runCloseAction(document) {
  return Function(
    'document',
    'getComputedStyle',
    `return (${CLOSE_PINE_EDITOR_EXPRESSION});`
  )(document, fakeStyle);
}

function pineUi() {
  return new FakeNode({ className: 'pine-dialog', visible: true });
}

test('selects a visible Pine Monaco when a hidden Monaco appears first', () => {
  const ui = pineUi();
  const hidden = new FakeNode({ className: 'monaco-editor pine-editor-monaco', visible: false });
  const visible = new FakeNode({ className: 'monaco-editor pine-editor-monaco', visible: true }).appendTo(ui);
  attachEnvironment(hidden, environment([editorFor(hidden)]));
  const visibleEditor = editorFor(visible);
  attachEnvironment(visible, environment([visibleEditor]));

  const result = runResolver(fakeDocument({ containers: [hidden, visible], uiNodes: [ui] }));
  assert.equal(result.state, 'ready');
  assert.equal(result.container, visible);
  assert.equal(result.editor, visibleEditor);
});

test('prefers a visible Monaco associated with the visible Pine dialog', () => {
  const ui = pineUi();
  const unrelated = new FakeNode({ className: 'monaco-editor pine-editor-monaco', visible: true });
  const associated = new FakeNode({ className: 'monaco-editor pine-editor-monaco', visible: true }).appendTo(ui);
  attachEnvironment(unrelated, environment([editorFor(unrelated)]));
  const associatedEditor = editorFor(associated);
  attachEnvironment(associated, environment([associatedEditor]));

  const result = runResolver(fakeDocument({ containers: [unrelated, associated], uiNodes: [ui] }));
  assert.equal(result.state, 'ready');
  assert.equal(result.container, associated);
  assert.equal(result.editor, associatedEditor);
});

test('does not fall back to an unrelated ready Monaco while the Pine dialog mount is pending', () => {
  const ui = pineUi();
  const unrelated = new FakeNode({ className: 'monaco-editor pine-editor-monaco', visible: true });
  attachEnvironment(unrelated, environment([editorFor(unrelated)]));

  const result = runResolver(fakeDocument({ containers: [unrelated], uiNodes: [ui] }));
  assert.equal(result.state, 'monaco_mount_pending');
  assert.equal(result.candidateContainerCount, 0);
});

test('reports ambiguity when two live editors claim the same exact container', () => {
  const ui = pineUi();
  const container = new FakeNode({ className: 'monaco-editor pine-editor-monaco' }).appendTo(ui);
  attachEnvironment(container, environment([editorFor(container), editorFor(container)]));

  const result = runResolver(fakeDocument({ containers: [container], uiNodes: [ui] }));
  assert.equal(result.state, 'ambiguous_editor');
  assert.equal(result.viableEditorCount, 2);
});

test('ignores a stale first editor and selects the editor matching the visible container', () => {
  const ui = pineUi();
  const container = new FakeNode({ className: 'monaco-editor pine-editor-monaco' }).appendTo(ui);
  const staleDom = new FakeNode({ className: 'monaco-editor', visible: false });
  const stale = editorFor(staleDom, { value: 'stale' });
  const current = editorFor(container, { value: 'current' });
  attachEnvironment(container, environment([stale, current]));

  const result = runResolver(fakeDocument({ containers: [container], uiNodes: [ui] }));
  assert.equal(result.state, 'ready');
  assert.equal(result.editor, current);
});

test('rejects editors whose DOM node does not correspond to the Pine container', () => {
  const ui = pineUi();
  const container = new FakeNode({ className: 'monaco-editor pine-editor-monaco' }).appendTo(ui);
  const unrelated = new FakeNode({ className: 'monaco-editor' });
  attachEnvironment(container, environment([editorFor(unrelated)]));

  const result = runResolver(fakeDocument({ containers: [container], uiNodes: [ui] }));
  assert.equal(result.state, 'monaco_mount_pending');
});

test('rejects disposed editors and models while allowing a unique live replacement', () => {
  const ui = pineUi();
  const container = new FakeNode({ className: 'monaco-editor pine-editor-monaco' }).appendTo(ui);
  const disposedEditor = editorFor(container, { disposed: true });
  const disposedModel = { uri: {}, isDisposed: () => true };
  const staleModelEditor = editorFor(container, { model: disposedModel });
  const liveEditor = editorFor(container, { value: 'live' });
  attachEnvironment(container, environment([disposedEditor, staleModelEditor, liveEditor]));

  const result = runResolver(fakeDocument({ containers: [container], uiNodes: [ui] }));
  assert.equal(result.state, 'ready');
  assert.equal(result.editor, liveEditor);
});

test('finds monacoEnv beyond the former 15-Fiber-level limit', () => {
  const ui = pineUi();
  const container = new FakeNode({ className: 'monaco-editor pine-editor-monaco' }).appendTo(ui);
  attachEnvironment(container, environment([editorFor(container)]), { depth: 24 });

  const result = runResolver(fakeDocument({ containers: [container], uiNodes: [ui] }));
  assert.equal(result.state, 'ready');
});

test('finds monacoEnv through an alternate Fiber path', () => {
  const ui = pineUi();
  const container = new FakeNode({ className: 'monaco-editor pine-editor-monaco' }).appendTo(ui);
  attachEnvironment(container, environment([editorFor(container)]), { alternate: true });

  const result = runResolver(fakeDocument({ containers: [container], uiNodes: [ui] }));
  assert.equal(result.state, 'ready');
});

test('reports Monaco mount pending when the Pine dialog exists before Monaco', () => {
  const result = runResolver(fakeDocument({ uiNodes: [pineUi()] }));
  assert.equal(result.state, 'monaco_mount_pending');
});

test('distinguishes missing Monaco environment from an empty editor registry', () => {
  const ui = pineUi();
  const withoutEnvironment = new FakeNode({ className: 'monaco-editor pine-editor-monaco' }).appendTo(ui);
  assert.equal(
    runResolver(fakeDocument({ containers: [withoutEnvironment], uiNodes: [ui] })).state,
    'monaco_env_absent'
  );

  const withEmptyEnvironment = new FakeNode({ className: 'monaco-editor pine-editor-monaco' }).appendTo(ui);
  attachEnvironment(withEmptyEnvironment, environment([]));
  assert.equal(
    runResolver(fakeDocument({ containers: [withEmptyEnvironment], uiNodes: [ui] })).state,
    'editors_empty'
  );
});

test('reports model_absent until the matching editor receives a model', () => {
  const ui = pineUi();
  const container = new FakeNode({ className: 'monaco-editor pine-editor-monaco' }).appendTo(ui);
  let model = null;
  const editor = {
    getDomNode: () => container,
    getModel: () => model,
  };
  attachEnvironment(container, environment([editor]));
  const document = fakeDocument({ containers: [container], uiNodes: [ui] });

  assert.equal(runResolver(document).state, 'model_absent');
  model = { uri: { toString: () => 'pine://mounted' } };
  assert.equal(runResolver(document).state, 'ready');
});

test('treats hidden stale containers without visible Pine UI as absent and safe to reopen', () => {
  const hidden = new FakeNode({ className: 'monaco-editor pine-editor-monaco', visible: false });
  const result = runResolver(fakeDocument({ containers: [hidden] }));
  assert.equal(result.state, 'pine_ui_absent');
  assert.equal(result.containerCount, 1);
});

test('does not invoke a present but unusable legacy bottomWidgetBar path', () => {
  let activations = 0;
  const window = {
    TradingView: {
      bottomWidgetBar: {
        isVisible: () => ({ value: () => false }),
        isWidgetEnabled: () => true,
        getWidgetByName: () => ({}),
        activateScriptEditorTab: () => { activations++; },
      },
    },
  };

  const result = runOpenAction(fakeDocument(), window);
  assert.equal(result.attempted, false);
  assert.equal(result.reason, 'legacy_bottom_bar_unusable');
  assert.equal(activations, 0);
});

test('legacy open fallback requires enabled and present status for the same widget name', () => {
  let activations = 0;
  const window = {
    TradingView: {
      bottomWidgetBar: {
        isVisible: () => ({ value: () => true }),
        isWidgetEnabled: name => name === 'pine-editor',
        getWidgetByName: name => name === 'script-editor' ? {} : null,
        activateScriptEditorTab: () => { activations++; },
      },
    },
  };

  const result = runOpenAction(fakeDocument(), window);
  assert.equal(result.attempted, false);
  assert.equal(result.reason, 'legacy_bottom_bar_unusable');
  assert.equal(activations, 0);
});

test('chooses the visible semantic Pine button before a usable legacy path', () => {
  const hidden = new FakeNode({ tagName: 'BUTTON', visible: false, attributes: { 'aria-label': 'Pine' } });
  const visible = new FakeNode({ tagName: 'BUTTON', visible: true, attributes: { 'data-name': 'pine-dialog-button' } });
  let activations = 0;
  const window = {
    TradingView: {
      bottomWidgetBar: {
        isVisible: () => ({ value: () => true }),
        isWidgetEnabled: () => true,
        getWidgetByName: () => ({}),
        activateScriptEditorTab: () => { activations++; },
      },
    },
  };

  const result = runOpenAction(fakeDocument({ controls: [hidden, visible] }), window);
  assert.equal(result.method, 'pine_button');
  assert.equal(hidden.clicked, 0);
  assert.equal(visible.clicked, 1);
  assert.equal(activations, 0);
});

test('close action clicks a semantic Close control inside the visible Pine dialog', () => {
  const ui = pineUi();
  const close = new FakeNode({ tagName: 'BUTTON', attributes: { 'aria-label': 'Close' } });
  ui.queryNodes = [close];

  const result = runCloseAction(fakeDocument({ uiNodes: [ui] }));
  assert.equal(result.attempted, true);
  assert.equal(result.method, 'pine_dialog_close');
  assert.equal(close.clicked, 1);
});

test('waits through a Monaco DOM replacement without clicking an existing Pine UI again', async () => {
  const states = [
    { state: 'monaco_mount_pending' },
    { state: 'monaco_env_absent' },
    { state: 'ready', container_count: 1, visible_container_count: 1, editor_count: 1 },
  ];
  let opens = 0;
  const evaluate = async expression => {
    if (expression.includes('PINE_EDITOR_STATE')) return states.shift();
    if (expression.includes('OPEN_PINE_EDITOR')) { opens++; return { attempted: true, method: 'pine_button' }; }
    throw new Error('Unexpected expression');
  };

  const result = await ensurePineEditorOpenDetailed({ evaluate, sleep: async () => {}, maxAttempts: 4 });
  assert.equal(result.ready, true);
  assert.equal(result.attempts, 2);
  assert.equal(opens, 0);
});

test('reacquires after an editor remount between readiness and the source read', async () => {
  const results = [
    { ok: false, state: 'monaco_mount_pending' },
    { ok: true, value: 'reacquired', model_uri: 'pine://new' },
  ];
  let attempts = 0;
  const evaluate = async expression => {
    assert.match(expression, /PINE_EDITOR_OPERATION/);
    attempts++;
    return results.shift();
  };

  const result = await getSource({
    _deps: {
      ensureOptions: {
        evaluate: async expression => {
          assert.match(expression, /PINE_EDITOR_STATE/);
          return { state: 'ready' };
        },
      },
      operationOptions: { evaluate, sleep: async () => {} },
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.source, 'reacquired');
  assert.equal(attempts, 2);
});

test('operation-time disposal triggers bounded reacquisition', async () => {
  const results = [
    { ok: false, state: 'operation_stale' },
    { ok: false, state: 'operation_stale' },
    { ok: true, value: 'reacquired' },
  ];
  let attempts = 0;
  const result = await runPineEditorOperation(
    'function(editor) { return editor.getValue(); }',
    {
      evaluate: async expression => {
        assert.match(expression, /PINE_EDITOR_OPERATION/);
        attempts++;
        return results.shift();
      },
      sleep: async () => {},
      maxAttempts: 3,
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.value, 'reacquired');
  assert.equal(attempts, 3);
});

test('operation expression reacquires when the selected model goes stale before execution', async () => {
  const ui = pineUi();
  const container = new FakeNode({ className: 'monaco-editor pine-editor-monaco' }).appendTo(ui);
  const model = { uri: { toString: () => 'pine://live' }, isDisposed: () => false };
  let modelReads = 0;
  const staleDuringOperation = {
    getDomNode: () => container,
    getModel: () => (++modelReads === 1 ? model : null),
    isDisposed: () => false,
    getValue: () => 'must-not-run',
  };
  const live = editorFor(container, { model, value: 'reacquired-live' });
  let operationAttempts = 0;
  const env = environment([]);
  env.editor.getEditors = () => operationAttempts === 1 ? [staleDuringOperation] : [live];
  attachEnvironment(container, env);
  const document = fakeDocument({ containers: [container], uiNodes: [ui] });

  const result = await runPineEditorOperation(
    'function(editor) { return editor.getValue(); }',
    {
      evaluate: async expression => {
        operationAttempts++;
        return Function('document', 'getComputedStyle', `return (${expression});`)(document, fakeStyle);
      },
      sleep: async () => {},
      maxAttempts: 2,
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.value, 'reacquired-live');
  assert.equal(operationAttempts, 2);
});

test('operation reacquisition stops at its configured bound', async () => {
  let attempts = 0;
  const result = await runPineEditorOperation(
    'function(editor) { return editor.getValue(); }',
    {
      evaluate: async () => {
        attempts++;
        return { ok: false, state: 'operation_stale' };
      },
      sleep: async () => {},
      maxAttempts: 2,
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.state, 'operation_stale');
  assert.equal(attempts, 2);
});

test('sets source only on the verified visible editor when a stale editor is listed first', async () => {
  const ui = pineUi();
  const container = new FakeNode({ className: 'monaco-editor pine-editor-monaco' }).appendTo(ui);
  const staleDom = new FakeNode({ className: 'monaco-editor', visible: false });
  let staleValue = null;
  let currentValue = null;
  const model = { uri: { toString: () => 'pine://write-target' } };
  const stale = {
    getDomNode: () => staleDom,
    getModel: () => model,
    setValue: value => { staleValue = value; },
  };
  const current = {
    getDomNode: () => container,
    getModel: () => model,
    setValue: value => { currentValue = value; },
  };
  attachEnvironment(container, environment([stale, current]));
  const document = fakeDocument({ containers: [container], uiNodes: [ui] });
  const operationEvaluate = async expression => Function(
    'document',
    'getComputedStyle',
    `return (${expression});`
  )(document, fakeStyle);

  const result = await setSource({
    source: 'replacement source',
    _deps: {
      ensureOptions: { evaluate: async () => ({ state: 'ready' }) },
      operationOptions: { evaluate: operationEvaluate, sleep: async () => {} },
    },
  });
  assert.equal(result.success, true);
  assert.equal(staleValue, null);
  assert.equal(currentValue, 'replacement source');
});

test('supports repeated open, unmount, and reopen cycles with one click per absent UI', async () => {
  const states = [
    { state: 'pine_ui_absent' },
    { state: 'ready' },
    { state: 'pine_ui_absent' },
    { state: 'ready' },
  ];
  let opens = 0;
  const evaluate = async expression => {
    if (expression.includes('PINE_EDITOR_STATE')) return states.shift();
    if (expression.includes('OPEN_PINE_EDITOR')) {
      opens++;
      return { attempted: true, method: 'pine_button' };
    }
    throw new Error('Unexpected expression');
  };
  const options = { evaluate, sleep: async () => {}, maxAttempts: 2 };

  const first = await ensurePineEditorOpenDetailed(options);
  const second = await ensurePineEditorOpenDetailed(options);
  assert.equal(first.ready, true);
  assert.equal(second.ready, true);
  assert.equal(opens, 2);
});

test('public ensurePineEditorOpen preserves boolean success and failure results', async () => {
  const ready = await ensurePineEditorOpen({
    evaluate: async () => ({ state: 'ready' }),
  });
  assert.equal(ready, true);
  assert.equal(typeof ready, 'boolean');

  const failed = await ensurePineEditorOpen({
    evaluate: async expression => expression.includes('OPEN_PINE_EDITOR')
      ? { attempted: false, reason: 'no_open_control' }
      : { state: 'pine_ui_absent' },
    sleep: async () => {},
    maxAttempts: 2,
  });
  assert.equal(failed, false);
  assert.equal(typeof failed, 'boolean');
});

test('Pine open verifies the final ready state after a semantic open attempt', async () => {
  const states = [
    { state: 'pine_ui_absent', pine_ui_visible: false, visible_container_count: 0 },
    { state: 'pine_ui_absent', pine_ui_visible: false, visible_container_count: 0 },
    { state: 'ready', pine_ui_visible: true, visible_container_count: 1 },
  ];
  let opens = 0;
  const result = await openPanel({
    panel: 'pine-editor',
    action: 'open',
    _deps: {
      evaluate: async expression => {
        if (expression.includes('PINE_EDITOR_STATE')) return states.shift();
        if (expression.includes('OPEN_PINE_EDITOR')) {
          opens++;
          return { attempted: true, method: 'pine_button' };
        }
        throw new Error('Unexpected expression');
      },
      sleep: async () => {},
      maxAttempts: 2,
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.performed, 'opened');
  assert.equal(opens, 1);
});

test('Pine close succeeds only after UI and visible Monaco are absent', async () => {
  const states = [
    { state: 'ready', pine_ui_visible: true, visible_container_count: 1 },
    { state: 'pine_ui_absent', pine_ui_visible: false, visible_container_count: 0 },
  ];
  const result = await openPanel({
    panel: 'pine-editor',
    action: 'close',
    _deps: {
      getState: async () => states.shift(),
      evaluate: async expression => {
        assert.equal(expression, CLOSE_PINE_EDITOR_EXPRESSION);
        return { attempted: true, method: 'pine_dialog_close' };
      },
      sleep: async () => {},
      maxAttempts: 2,
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.performed, 'closed');
});

test('Pine toggle changes an open editor to closed', async () => {
  const states = [
    { state: 'ready', pine_ui_visible: true, visible_container_count: 1 },
    { state: 'pine_ui_absent', pine_ui_visible: false, visible_container_count: 0 },
  ];
  const result = await openPanel({
    panel: 'pine-editor',
    action: 'toggle',
    _deps: {
      getState: async () => states.shift(),
      evaluate: async () => ({ attempted: true, method: 'pine_dialog_close' }),
      sleep: async () => {},
      maxAttempts: 1,
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.was_open, true);
  assert.equal(result.performed, 'closed');
});

test('Pine toggle changes a closed editor to open', async () => {
  const result = await openPanel({
    panel: 'pine-editor',
    action: 'toggle',
    _deps: {
      getState: async () => ({ state: 'pine_ui_absent', pine_ui_visible: false, visible_container_count: 0 }),
      ensureOpen: async () => ({ ready: true, state: 'ready', attempts: 1, opened_with: 'pine_button' }),
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.was_open, false);
  assert.equal(result.performed, 'opened');
});

test('Pine action reports failure when an attempted close leaves state unchanged', async () => {
  let reads = 0;
  const result = await openPanel({
    panel: 'pine-editor',
    action: 'close',
    _deps: {
      getState: async () => {
        reads++;
        return { state: 'ready', pine_ui_visible: true, visible_container_count: 1 };
      },
      evaluate: async () => ({ attempted: true, method: 'pine_dialog_close' }),
      sleep: async () => {},
      maxAttempts: 2,
    },
  });
  assert.equal(result.success, false);
  assert.equal(result.performed, 'close_failed');
  assert.equal(reads, 3);
});

test('Pine open reports bounded timeout failure when readiness never changes', async () => {
  let polls = 0;
  const result = await openPanel({
    panel: 'pine-editor',
    action: 'open',
    _deps: {
      getState: async () => ({ state: 'pine_ui_absent', pine_ui_visible: false, visible_container_count: 0 }),
      ensureOpen: async options => {
        assert.equal(options.maxAttempts, 2);
        polls = options.maxAttempts;
        return { ready: false, state: 'pine_ui_absent', attempts: options.maxAttempts, open_attempted: true };
      },
      maxAttempts: 2,
    },
  });
  assert.equal(result.success, false);
  assert.equal(result.performed, 'open_failed');
  assert.equal(polls, 2);
});
