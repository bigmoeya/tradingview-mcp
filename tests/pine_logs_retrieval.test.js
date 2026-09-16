import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterPineLogEntries,
  getConsole,
} from '../src/core/pine.js';

class FakeElement {
  constructor({
    tagName = 'DIV',
    className = '',
    textContent = '',
    attributes = {},
    visible = true,
    connected = true,
    disabled = false,
    onClick = null,
  } = {}) {
    this.tagName = tagName;
    this.className = className;
    this.ownText = textContent;
    this.attributes = { ...attributes };
    this.visible = visible;
    this.isConnected = connected;
    this.disabled = disabled;
    this.onClick = onClick;
    this.children = [];
    this.parentElement = null;
    this.clicked = 0;
  }

  get textContent() {
    return this.ownText + this.children.map(child => child.textContent).join('');
  }

  set textContent(value) {
    this.ownText = value;
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
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
    if (name === 'class') return this.className || null;
    return this.attributes[name] ?? null;
  }

  click() {
    this.clicked++;
    if (this.onClick) this.onClick();
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = node => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
}

function matchesSelector(node, selector) {
  return selector.split(',').some(part => {
    const value = part.trim();
    const tag = value.match(/^([a-z][a-z0-9-]*)/i);
    if (tag && node.tagName.toLowerCase() !== tag[1].toLowerCase()) return false;

    for (const classMatch of value.matchAll(/\.([a-z0-9_-]+)/gi)) {
      if (!String(node.className).split(/\s+/).includes(classMatch[1])) return false;
    }

    for (const attrMatch of value.matchAll(/\[([^\]=~*^$]+)(?:(\*=|\^=|=)"([^"]*)")?\]/g)) {
      const name = attrMatch[1].trim();
      const actual = node.getAttribute(name);
      if (actual === null) return false;
      if (!attrMatch[2]) continue;
      const expected = attrMatch[3];
      if (attrMatch[2] === '=' && actual !== expected) return false;
      if (attrMatch[2] === '*=' && !actual.includes(expected)) return false;
      if (attrMatch[2] === '^=' && !actual.startsWith(expected)) return false;
    }
    return true;
  });
}

class FakeDocument {
  constructor(nodes = []) {
    this.documentElement = new FakeElement({ tagName: 'HTML' });
    for (const node of nodes) this.append(node);
  }

  append(node) {
    this.documentElement.append(node);
    return node;
  }

  querySelector(selector) {
    return this.documentElement.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.documentElement.querySelectorAll(selector);
  }
}

function fakeStyle(node) {
  return {
    display: node.visible ? 'block' : 'none',
    visibility: node.visible ? 'visible' : 'hidden',
    opacity: node.visible ? '1' : '0',
  };
}

function runtimePanel(entries, {
  scriptName = null,
  visible = true,
  connected = true,
  scriptIdentities = [],
} = {}) {
  const panel = new FakeElement({
    className: 'widget-aKdZqnMd widgetbar-widget widgetbar-widget-pine_logs',
    attributes: scriptName ? { 'data-script-name': scriptName } : {},
    visible,
    connected,
  });
  for (const identity of scriptIdentities) {
    panel.append(new FakeElement({ attributes: identity }));
  }
  for (const entry of entries) {
    const row = new FakeElement({
      className: `logContainer-${entry.containerSuffix || 'row'}`,
      attributes: entry.level ? { 'data-level': entry.level } : {},
    });
    row.append(new FakeElement({
      tagName: 'SPAN',
      className: `msg-${entry.messageSuffix || 'msg'}`,
      textContent: entry.text,
    }));
    panel.append(row);
  }
  return panel;
}

function pineEditorRoot(children = []) {
  const root = new FakeElement({ className: 'pine-editor-container' });
  for (const child of children) root.append(child);
  return root;
}

function testEvaluate(document) {
  const expressions = [];
  const evaluate = async expression => {
    expressions.push(expression);
    if (expression.includes('PINE_EDITOR_STATE')) return { state: 'ready' };
    return Function(
      'document',
      'getComputedStyle',
      `return (${expression});`,
    )(document, fakeStyle);
  };
  return { evaluate, expressions };
}

async function readConsole(document, options = {}) {
  const deps = testEvaluate(document);
  const result = await getConsole({
    _deps: {
      evaluate: deps.evaluate,
      sleep: async () => {},
      logMaxAttempts: 3,
      logIntervalMs: 0,
      ...options,
    },
  });
  return { result, expressions: deps.expressions };
}

test('extracts timestamped multiple runtime entries and ignores unrelated page logs', async () => {
  const unrelated = new FakeElement({
    className: 'generic-consoleRow generic-log-message',
    textContent: '[2026-09-16T03:43:52.444-04:00]: page noise',
  });
  const panel = runtimePanel([
    {
      text: '[2026-09-16T03:43:52.444-04:00]: first runtime message',
      level: 'info',
      containerSuffix: 'alpha',
      messageSuffix: 'bravo',
    },
    {
      text: '[2026-09-16T03:43:53.111-04:00]: second runtime message',
      level: 'warning',
      containerSuffix: 'charlie',
      messageSuffix: 'delta',
    },
  ]);
  const { result } = await readConsole(new FakeDocument([unrelated, panel]));

  assert.equal(result.success, true);
  assert.equal(result.source_scope, 'widgetbar-widget-pine_logs');
  assert.equal(result.script_name, null);
  assert.equal(result.script_association, 'unknown');
  assert.deepEqual(result.entries, [
    {
      timestamp: '2026-09-16T03:43:52.444-04:00',
      type: 'info',
      level: 'info',
      message: 'first runtime message',
    },
    {
      timestamp: '2026-09-16T03:43:53.111-04:00',
      type: 'warning',
      level: 'warning',
      message: 'second runtime message',
    },
  ]);
  assert.equal(result.entry_count, 2);
});

test('preserves an explicit Pine Logs script identity and generated class suffixes', async () => {
  const panel = runtimePanel([
    {
      text: '[2026-09-16T03:44:00.000-04:00]: suffix-safe',
      level: 'debug',
      containerSuffix: 'generated-container-42',
      messageSuffix: 'generated-message-99',
    },
  ], { scriptName: 'S2H4B Classifier Fixture Smoke' });
  const { result } = await readConsole(new FakeDocument([panel]));

  assert.equal(result.script_name, 'S2H4B Classifier Fixture Smoke');
  assert.equal(result.script_selector, 'data-script-name');
  assert.equal(result.script_association, 'known');
  assert.deepEqual(result.entries[0], {
    timestamp: '2026-09-16T03:44:00.000-04:00',
    type: 'debug',
    level: 'debug',
    message: 'suffix-safe',
  });
});

test('opens More then the exact Pine logs menu item when the panel is absent', async () => {
  let panel = null;
  let document;
  const menu = new FakeElement({
    tagName: 'DIV',
    attributes: { role: 'menuitem' },
    textContent: 'Pine logs',
    visible: false,
    onClick: () => {
      panel = runtimePanel([{
        text: '[2026-09-16T03:45:00.000-04:00]: mounted after menu',
        level: 'info',
      }]);
      document.append(panel);
    },
  });
  const more = new FakeElement({
    tagName: 'BUTTON',
    attributes: { title: 'More' },
    onClick: () => { menu.visible = true; },
  });
  document = new FakeDocument([pineEditorRoot([more]), menu]);
  const { result } = await readConsole(document);

  assert.equal(more.clicked, 1);
  assert.equal(menu.clicked, 1);
  assert.equal(result.entries[0].message, 'mounted after menu');
});

test('returns a successful empty result for an empty mounted Pine Logs panel', async () => {
  const panel = runtimePanel([]);
  const { result } = await readConsole(new FakeDocument([panel]));

  assert.equal(result.success, true);
  assert.equal(result.entry_count, 0);
  assert.deepEqual(result.entries, []);
});

test('rejects a source-history marker when Pine Logs has no runtime entries', async () => {
  const sourceHistory = new FakeElement({
    className: 'monaco-editor pine-editor-monaco',
    textContent: '//@version=6 indicator(\"Probe\") log.info(\"S2H4B_LOG_PROBE=PASS\") plot(close)',
  });
  const { result } = await readConsole(new FakeDocument([sourceHistory, runtimePanel([])]));

  assert.equal(result.success, true);
  assert.equal(result.entry_count, 0);
  assert.equal(result.entries.some(entry => entry.message.includes('S2H4B_LOG_PROBE=PASS')), false);
});

test('returns only the runtime marker when source history and Pine Logs both contain it', async () => {
  const sourceHistory = new FakeElement({
    className: 'monaco-editor pine-editor-monaco',
    textContent: '//@version=6 indicator(\"Probe\") log.info(\"S2H4B_LOG_PROBE=PASS\") plot(close)',
  });
  const panel = runtimePanel([{
    text: '[2026-09-16T03:46:00.000-04:00]: S2H4B_LOG_PROBE=PASS',
    level: 'info',
  }]);
  const { result } = await readConsole(new FakeDocument([sourceHistory, panel]));

  assert.equal(result.entry_count, 1);
  assert.deepEqual(result.entries[0], {
    timestamp: '2026-09-16T03:46:00.000-04:00',
    type: 'info',
    level: 'info',
    message: 'S2H4B_LOG_PROBE=PASS',
  });
});

test('ignores a hidden stale Pine Logs widget', async () => {
  const stale = runtimePanel([{
    text: '[2026-09-16T03:47:00.000-04:00]: stale hidden message',
    level: 'error',
  }], { visible: false });
  let document;
  const menu = new FakeElement({
    tagName: 'DIV',
    attributes: { role: 'menuitem' },
    textContent: 'Pine logs',
    visible: false,
    onClick: () => {
      document.append(runtimePanel([{
        text: '[2026-09-16T03:47:01.000-04:00]: current mounted message',
        level: 'info',
      }]));
    },
  });
  const more = new FakeElement({
    tagName: 'BUTTON',
    attributes: { title: 'More' },
    onClick: () => { menu.visible = true; },
  });
  document = new FakeDocument([stale, pineEditorRoot([more]), menu]);

  const { result } = await readConsole(document);
  assert.deepEqual(result.entries.map(entry => entry.message), ['current mounted message']);
});

test('uses the visible current widget when a hidden widget precedes it', async () => {
  const hidden = runtimePanel([{
    text: '[2026-09-16T03:47:10.000-04:00]: stale hidden message',
    level: 'error',
  }], { visible: false });
  const current = runtimePanel([{
    text: '[2026-09-16T03:47:11.000-04:00]: current visible message',
    level: 'info',
  }]);
  const { result } = await readConsole(new FakeDocument([hidden, current]));

  assert.equal(result.success, true);
  assert.deepEqual(result.entries.map(entry => entry.message), ['current visible message']);
});

test('does not click an unrelated page-wide More before the Pine Editor More', async () => {
  let document;
  const unrelatedMore = new FakeElement({
    tagName: 'BUTTON',
    attributes: { title: 'More' },
  });
  const menu = new FakeElement({
    tagName: 'DIV',
    attributes: { role: 'menuitem' },
    textContent: 'Pine logs',
    visible: false,
    onClick: () => {
      document.append(runtimePanel([{
        text: '[2026-09-16T03:47:20.000-04:00]: scoped More worked',
        level: 'info',
      }]));
    },
  });
  const pineMore = new FakeElement({
    tagName: 'BUTTON',
    attributes: { title: 'More' },
    onClick: () => { menu.visible = true; },
  });
  document = new FakeDocument([unrelatedMore, pineEditorRoot([pineMore]), menu]);

  const { result } = await readConsole(document);
  assert.equal(unrelatedMore.clicked, 0);
  assert.equal(pineMore.clicked, 1);
  assert.equal(menu.clicked, 1);
  assert.equal(result.entries[0].message, 'scoped More worked');
});

test('fails explicitly when the Pine Editor exposes multiple viable More controls', async () => {
  const firstMore = new FakeElement({ tagName: 'BUTTON', attributes: { title: 'More' } });
  const secondMore = new FakeElement({ tagName: 'BUTTON', attributes: { title: 'More' } });
  await assert.rejects(
    () => readConsole(new FakeDocument([pineEditorRoot([firstMore, secondMore])])),
    /Pine Logs could not be opened: ambiguous_visible_enabled_more_buttons/,
  );
  assert.equal(firstMore.clicked, 0);
  assert.equal(secondMore.clicked, 0);
});

test('preserves a genuine runtime message containing plot(close)', async () => {
  const panel = runtimePanel([{
    text: '[2026-09-16T03:47:30.000-04:00]: runtime diagnostic: plot(close)',
    level: 'info',
  }]);
  const { result } = await readConsole(new FakeDocument([panel]));

  assert.equal(result.success, true);
  assert.equal(result.entries[0].message, 'runtime diagnostic: plot(close)');
});

test('reports ambiguous script association for conflicting explicit identities', async () => {
  const panel = runtimePanel([{
    text: '[2026-09-16T03:47:40.000-04:00]: identity conflict remains observable',
    level: 'info',
  }], {
    scriptIdentities: [
      { 'data-script-name': 'Fixture A', 'aria-selected': 'true' },
      { 'data-script-title': 'Fixture B', 'aria-selected': 'true' },
    ],
  });
  const { result } = await readConsole(new FakeDocument([panel]));

  assert.equal(result.script_name, null);
  assert.equal(result.script_selector, null);
  assert.equal(result.script_association, 'ambiguous');
  assert.equal(result.entries.length, 1);
});

test('does not promote an unselected descendant script label', async () => {
  const panel = runtimePanel([{
    text: '[2026-09-16T03:47:45.000-04:00]: identity remains unverified',
  }], {
    scriptIdentities: [{ 'data-script-name': 'Unselected label' }],
  });
  const { result } = await readConsole(new FakeDocument([panel]));

  assert.equal(result.script_name, null);
  assert.equal(result.script_selector, null);
  assert.equal(result.script_association, 'unknown');
});

test('fails explicitly when two visible Pine Logs widgets are present', async () => {
  const first = runtimePanel([{
    text: '[2026-09-16T03:47:50.000-04:00]: first visible widget',
  }]);
  const second = runtimePanel([{
    text: '[2026-09-16T03:47:51.000-04:00]: second visible widget',
  }]);

  await assert.rejects(
    () => readConsole(new FakeDocument([first, second])),
    /Pine Logs could not be used: ambiguous_visible_pine_logs_widgets/,
  );
});

test('fails explicitly when Pine Logs cannot mount and never falls back to generic logs', async () => {
  const genericLog = new FakeElement({
    className: 'consoleRow log-message',
    textContent: 'S2H4B_LOG_PROBE=PASS',
  });
  await assert.rejects(
   () => readConsole(new FakeDocument([pineEditorRoot(), genericLog])),
    /Pine Logs could not be opened:.*visible_enabled_more_button_not_found/,
  );
});

test('reports a bounded menu-mount failure after activating More', async () => {
  const more = new FakeElement({
    tagName: 'BUTTON',
    attributes: { title: 'More' },
  });
  const document = new FakeDocument([pineEditorRoot([more])]);

  await assert.rejects(
    () => readConsole(document),
    /Pine Logs could not be opened:.*visible_enabled_pine_logs_menuitem_not_found/,
  );
  assert.equal(more.clicked, 1);
});

test('fails after More and Pine logs activate but no widget ever mounts', async () => {
  let document;
  const menu = new FakeElement({
    tagName: 'DIV',
    attributes: { role: 'menuitem' },
    textContent: 'Pine logs',
    visible: false,
  });
  const more = new FakeElement({
    tagName: 'BUTTON',
    attributes: { title: 'More' },
    onClick: () => { menu.visible = true; },
  });
  const genericLog = new FakeElement({
    className: 'consoleRow log-message',
    textContent: 'runtime diagnostic: plot(close)',
  });
  document = new FakeDocument([pineEditorRoot([more]), menu, genericLog]);

  await assert.rejects(
    () => readConsole(document),
    /Pine Logs could not be mounted after opening Pine logs: widget_not_mounted/,
  );
  assert.equal(more.clicked, 1);
  assert.equal(menu.clicked, 1);
});

test('preserves structurally verified runtime text containing Pine syntax-like tokens', () => {
  const entries = filterPineLogEntries([
    { timestamp: null, type: 'info', level: 'info', message: '//@version=6 indicator(\"x\") plot(close)' },
    { timestamp: 't', type: 'info', level: 'info', message: 'S2H4B_LOG_PROBE=PASS' },
  ]);

  assert.deepEqual(entries, [
    { timestamp: null, type: 'info', level: 'info', message: '//@version=6 indicator("x") plot(close)' },
    { timestamp: 't', type: 'info', level: 'info', message: 'S2H4B_LOG_PROBE=PASS' },
  ]);
});
