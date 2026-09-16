/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';
import {
  ensurePineEditorOpenDetailed,
  getPineEditorStateDetailed,
  runPineEditorOperation,
} from './pine-editor.js';

export async function getPineEditorState(options = {}) {
  return getPineEditorStateDetailed(options);
}

/**
 * Opens the Pine Editor panel and waits for Monaco to become available.
 * Preserves the original public Promise<boolean> contract.
 */
export async function ensurePineEditorOpen(options = {}) {
  const result = await ensurePineEditorOpenDetailed(options);
  return result.ready;
}

// ── Pure / offline functions ──

export function analyze({ source }) {
  const lines = source.split('\n');
  const diagnostics = [];

  let isV6 = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//@version=6')) { isV6 = true; break; }
    if (trimmed.startsWith('//@version=')) break;
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    break;
  }

  const arrays = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromMatch = line.match(/(\w+)\s*=\s*array\.from\(([^)]*)\)/);
    if (fromMatch) {
      const name = fromMatch[1].trim();
      const args = fromMatch[2].trim();
      const size = args === '' ? 0 : args.split(',').length;
      arrays.set(name, { name, size, line: i + 1 });
      continue;
    }
    const newMatch = line.match(/(\w+)\s*=\s*array\.new(?:<\w+>|_\w+)\((\d+)?/);
    if (newMatch) {
      const name = newMatch[1].trim();
      const size = newMatch[2] !== undefined ? parseInt(newMatch[2], 10) : null;
      arrays.set(name, { name, size, line: i + 1 });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pattern = /array\.(get|set)\(\s*(\w+)\s*,\s*(-?\d+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const method = match[1];
      const arrName = match[2];
      const idx = parseInt(match[3], 10);
      const info = arrays.get(arrName);
      if (!info || info.size === null) continue;
      if (idx < 0 || idx >= info.size) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `array.${method}(${arrName}, ${idx}) — index ${idx} out of bounds (array size is ${info.size})`,
          severity: 'error',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstLastPattern = /(\w+)\.(first|last)\(\)/g;
    let match;
    while ((match = firstLastPattern.exec(line)) !== null) {
      const arrName = match[1];
      if (arrName === 'array') continue;
      const info = arrays.get(arrName);
      if (info && info.size === 0) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `${arrName}.${match[2]}() called on possibly empty array (declared with size 0)`,
          severity: 'warning',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.includes('strategy.entry') || trimmed.includes('strategy.close')) {
      let hasStrategyDecl = false;
      for (const l of lines) {
        if (l.trim().startsWith('strategy(')) { hasStrategyDecl = true; break; }
      }
      if (!hasStrategyDecl) {
        diagnostics.push({
          line: i + 1, column: 1,
          message: 'strategy.entry/close used but no strategy() declaration found — did you mean to use indicator()?',
          severity: 'error',
        });
        break;
      }
    }
  }

  if (!isV6 && source.includes('//@version=')) {
    const vMatch = source.match(/\/\/@version=(\d+)/);
    if (vMatch && parseInt(vMatch[1]) < 5) {
      diagnostics.push({
        line: 1, column: 1,
        message: `Script uses Pine v${vMatch[1]} — consider upgrading to v6 for latest features`,
        severity: 'info',
      });
    }
  }

  return {
    success: true,
    issue_count: diagnostics.length,
    diagnostics,
    note: diagnostics.length === 0 ? 'No static analysis issues found. Use pine_compile or pine_smart_compile for full server-side compilation check.' : undefined,
  };
}

export async function check({ source }) {
  const formData = new URLSearchParams();
  formData.append('source', source);

  const response = await fetch(
    'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.tradingview.com/',
      },
      body: formData,
    }
  );

  if (!response.ok) {
    throw new Error(`TradingView API returned ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  const errors = [];
  const warnings = [];
  const inner = result?.result;

  if (inner) {
    if (inner.errors2 && inner.errors2.length > 0) {
      for (const e of inner.errors2) {
        errors.push({
          line: e.start?.line, column: e.start?.column,
          end_line: e.end?.line, end_column: e.end?.column,
          message: e.message,
        });
      }
    }
    if (inner.warnings2 && inner.warnings2.length > 0) {
      for (const w of inner.warnings2) {
        warnings.push({ line: w.start?.line, column: w.start?.column, message: w.message });
      }
    }
  }

  if (result.error && typeof result.error === 'string') {
    errors.push({ message: result.error });
  }

  const compiled = errors.length === 0;
  return {
    success: true,
    compiled,
    error_count: errors.length,
    warning_count: warnings.length,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    note: compiled ? 'Pine Script compiled successfully.' : undefined,
  };
}

// ── Functions requiring TradingView connection ──

function pineUnavailableMessage(prefix, status) {
  return `${prefix} (state: ${status?.state || 'unknown'}).`;
}

export async function getSource(options = {}) {
  const editorStatus = await ensurePineEditorOpenDetailed(options._deps?.ensureOptions || {});
  if (!editorStatus.ready) throw new Error(pineUnavailableMessage('Could not open Pine Editor', editorStatus));

  const result = await runPineEditorOperation(
    `function(editor) { return editor.getValue(); }`,
    options._deps?.operationOptions || {}
  );
  if (!result?.ok) throw new Error(pineUnavailableMessage('Could not reacquire Pine Editor', result));
  const source = result.value;

  if (source === null || source === undefined) {
    throw new Error('Monaco editor found but getValue() returned null.');
  }

  return { success: true, source, line_count: source.split('\n').length, char_count: source.length };
}

export async function setSource({ source, _deps }) {
  const editorStatus = await ensurePineEditorOpenDetailed(_deps?.ensureOptions || {});
  if (!editorStatus.ready) throw new Error(pineUnavailableMessage('Could not open Pine Editor', editorStatus));

  const escaped = JSON.stringify(source);
  const result = await runPineEditorOperation(
    `function(editor) { editor.setValue(${escaped}); return true; }`,
    _deps?.operationOptions || {}
  );

  if (!result?.ok || !result.value) throw new Error(pineUnavailableMessage('Could not set Pine source', result));
  return { success: true, lines_set: source.split('\n').length };
}

export async function compile() {
  const editorStatus = await ensurePineEditorOpenDetailed();
  if (!editorStatus.ready) throw new Error(pineUnavailableMessage('Could not open Pine Editor', editorStatus));

  const clicked = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      var fallback = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!fallback && /^(Add to chart|Update on chart)/i.test(text)) {
          fallback = btns[i];
        }
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) {
          saveBtn = btns[i];
        }
      }
      if (fallback) { fallback.click(); return fallback.textContent.trim(); }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  if (!clicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2000));
  return { success: true, button_clicked: clicked || 'keyboard_shortcut', source: 'dom_fallback' };
}

export async function getErrors() {
  const editorStatus = await ensurePineEditorOpenDetailed();
  if (!editorStatus.ready) throw new Error(pineUnavailableMessage('Could not open Pine Editor', editorStatus));

  const result = await runPineEditorOperation(`
    function(editor, env, model) {
      return env.editor.getModelMarkers({ resource: model.uri }).map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
  `);
  if (!result?.ok) throw new Error(pineUnavailableMessage('Could not reacquire Pine Editor', result));
  const errors = result.value || [];

  return {
    success: true,
    has_errors: errors?.length > 0,
    error_count: errors?.length || 0,
    errors: errors || [],
  };
}

export async function save() {
  const editorStatus = await ensurePineEditorOpenDetailed();
  if (!editorStatus.ready) throw new Error(pineUnavailableMessage('Could not open Pine Editor', editorStatus));

  const c = await getClient();
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });
  await new Promise(r => setTimeout(r, 800));

  // Handle "Save Script" name dialog that appears for new/unsaved scripts
  const dialogHandled = await evaluate(`
    (function() {
      var saveBtn = null;
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (text === 'Save' && btns[i].offsetParent !== null) {
          // Check if it's in a dialog (not the Pine Editor save button)
          var parent = btns[i].closest('[class*="dialog"], [class*="modal"], [class*="popup"], [role="dialog"]');
          if (parent) { saveBtn = btns[i]; break; }
        }
      }
      if (saveBtn) { saveBtn.click(); return true; }
      return false;
    })()
  `);

  if (dialogHandled) await new Promise(r => setTimeout(r, 500));

  return { success: true, action: dialogHandled ? 'saved_with_dialog' : 'Ctrl+S_dispatched' };
}

// These expressions deliberately stay separate: the More menu can render
// asynchronously after its button is activated, while the Pine Logs widget
// can take another bounded interval to mount.
export const PINE_LOGS_OPEN_MORE_EXPRESSION = `
  /* PINE_LOGS_OPEN_MORE */
  (function() {
    function isLayoutVisible(node) {
      if (!node || node.isConnected !== true) return false;
      if (document.documentElement && !document.documentElement.contains(node)) return false;
      var rect = node.getBoundingClientRect();
      var style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) !== 0;
    }
    function isPineEditorUi(node) {
      if (!isLayoutVisible(node)) return false;
      var marker = ((node.getAttribute && node.getAttribute('data-name')) || '')
        + ' ' + (typeof node.className === 'string' ? node.className : '');
      if (/pine[-_ ]?(dialog|editor)/i.test(marker)) return true;
      var titles = node.querySelectorAll ? node.querySelectorAll('h1, h2, h3, [class*="title"]') : [];
      return Array.from(titles).some(function(title) {
        return /^Pine Editor$/i.test((title.textContent || '').trim());
      });
    }
    function visiblePineEditorRoots() {
      var candidates = Array.from(document.querySelectorAll(
        '[role="dialog"], [data-name="pine-dialog"], [class*="pine-dialog"], [class*="pineEditor"], .pine-editor-container'
      )).filter(isPineEditorUi);
      return candidates.filter(function(candidate) {
        return !candidates.some(function(other) {
          return other !== candidate && other.contains && other.contains(candidate);
        });
      });
    }
    function isEnabled(node) {
      return node.disabled !== true
        && node.getAttribute('disabled') === null
        && node.getAttribute('aria-disabled') !== 'true';
    }

    var roots = visiblePineEditorRoots();
    if (roots.length === 0) {
      return { attempted: false, method: null, reason: 'pine_editor_ui_root_not_found' };
    }
    if (roots.length > 1) {
      return { attempted: false, method: null, reason: 'ambiguous_pine_editor_ui_roots', root_count: roots.length };
    }

    var controls = Array.from(roots[0].querySelectorAll('button[title="More"], [role="button"][title="More"]'))
      .filter(function(control) {
        return control.getAttribute('title') === 'More'
          && isLayoutVisible(control)
          && isEnabled(control);
      });
    if (controls.length === 0) {
      return { attempted: false, method: null, reason: 'visible_enabled_more_button_not_found' };
    }
    if (controls.length > 1) {
      return { attempted: false, method: null, reason: 'ambiguous_visible_enabled_more_buttons', control_count: controls.length };
    }
    controls[0].click();
    return { attempted: true, method: 'more_button', title: 'More' };
  })()
`;

export const PINE_LOGS_OPEN_MENU_EXPRESSION = `
  /* PINE_LOGS_OPEN_MENU */
  (function() {
    function isVisible(node) {
      if (!node || node.isConnected !== true) return false;
      if (document.documentElement && !document.documentElement.contains(node)) return false;
      var rect = node.getBoundingClientRect();
      var style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) !== 0;
    }
    function isEnabled(node) {
      return node.disabled !== true
        && node.getAttribute('disabled') === null
        && node.getAttribute('aria-disabled') !== 'true';
    }

    var menuItems = Array.from(document.querySelectorAll('[role="menuitem"]'));
    for (var i = 0; i < menuItems.length; i++) {
      var text = (menuItems[i].textContent || '').trim();
      if (text === 'Pine logs' && isVisible(menuItems[i]) && isEnabled(menuItems[i])) {
        menuItems[i].click();
        return { attempted: true, method: 'pine_logs_menuitem', text: text };
      }
    }
    return { attempted: false, method: null, reason: 'visible_enabled_pine_logs_menuitem_not_found' };
  })()
`;

export const PINE_LOGS_READ_EXPRESSION = `
  /* PINE_LOGS_READ */
  (function() {
    function attribute(node, names) {
      for (var i = 0; i < names.length; i++) {
        var value = node && node.getAttribute ? node.getAttribute(names[i]) : null;
        if (value !== null && String(value).trim() !== '') return String(value).trim();
      }
      return null;
    }
    function scriptScope(panel) {
      var names = ['data-script-name', 'data-script-title', 'data-script-id'];
      function addIdentity(identities, node) {
        for (var nameIndex = 0; nameIndex < names.length; nameIndex++) {
          var value = attribute(node, [names[nameIndex]]);
          if (!value) continue;
          var alreadyKnown = false;
          for (var identityIndex = 0; identityIndex < identities.length; identityIndex++) {
            if (identities[identityIndex].name === value) {
              alreadyKnown = true;
              break;
            }
          }
          if (!alreadyKnown) identities.push({ name: value, selector: names[nameIndex] });
        }
      }

      // A verified widget-root identity is authoritative. Descendant labels
      // may belong to stale selector rows and cannot override the root.
      var rootIdentities = [];
      addIdentity(rootIdentities, panel);
      if (rootIdentities.length === 1) {
        return { name: rootIdentities[0].name, selector: rootIdentities[0].selector, association: 'known' };
      }
      if (rootIdentities.length > 1) {
        return { name: null, selector: null, association: 'ambiguous' };
      }

      var identityNodes = Array.from(panel.querySelectorAll(
        '[data-script-name], [data-script-title], [data-script-id]'
      ));
      var activeNodes = identityNodes.filter(function(node) {
        var states = ['aria-selected', 'data-active', 'aria-current', 'data-selected'];
        for (var stateIndex = 0; stateIndex < states.length; stateIndex++) {
          var state = attribute(node, [states[stateIndex]]);
          if (state && /^(true|yes|active|page)$/i.test(state)) return true;
        }
        return false;
      });
      // Prefer semantically active identities. If none are exposed, do not
      // promote a lone descendant label; only conflicting explicit labels are
      // reported as ambiguous so stale selectors cannot be mistaken for the
      // active script.
      var candidates = activeNodes.length > 0 ? activeNodes : identityNodes;
      var identities = [];
      for (var nodeIndex = 0; nodeIndex < candidates.length; nodeIndex++) {
        addIdentity(identities, candidates[nodeIndex]);
      }
      if (identities.length === 0) {
        return { name: null, selector: null, association: 'unknown' };
      }
      if (identities.length > 1) {
        return { name: null, selector: null, association: 'ambiguous' };
      }
      if (activeNodes.length === 0) {
        return { name: null, selector: null, association: 'unknown' };
      }
      return { name: identities[0].name, selector: identities[0].selector, association: 'known' };
    }
    function levelFor(container, messageNode) {
      var level = attribute(messageNode, ['data-level', 'data-log-level', 'aria-level'])
        || attribute(container, ['data-level', 'data-log-level', 'aria-level']);
      if (!level) {
        var classes = (typeof container.className === 'string' ? container.className : '')
          + ' ' + (typeof messageNode.className === 'string' ? messageNode.className : '');
        if (/error/i.test(classes)) level = 'error';
        else if (/warn/i.test(classes)) level = 'warning';
        else if (/debug/i.test(classes)) level = 'debug';
        else if (/info/i.test(classes)) level = 'info';
      }
      return level ? String(level).toLowerCase() : 'info';
    }
    function parseMessage(text) {
      var timestamp = null;
      var message = text;
      var match = text.match(/^\\[([^\\]]+)\\]\\s*:\\s*([\\s\\S]*)$/);
      if (!match) match = text.match(/^(\\d{4}-\\d{2}-\\d{2}T[^\\s]+|\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?)\\s*[:\\-]\\s*([\\s\\S]*)$/);
      if (match) {
        timestamp = match[1].trim();
        message = match[2].trim();
      }
      return { timestamp: timestamp, message: message };
    }
    var widgets = Array.from(document.querySelectorAll('div.widgetbar-widget-pine_logs'));
    var visibleWidgets = widgets.filter(function(widget) {
      if (!widget || widget.isConnected !== true
          || (document.documentElement && !document.documentElement.contains(widget))) return false;
      var rect = widget.getBoundingClientRect();
      var style = getComputedStyle(widget);
      return rect.width > 0 && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) !== 0;
    });
    if (visibleWidgets.length === 0) {
      return {
        mounted: false,
        entries: [],
        script_name: null,
        script_selector: null,
        script_association: 'unknown',
        source_scope: 'widgetbar-widget-pine_logs',
        widget_count: widgets.length,
        visible_widget_count: 0,
        reason: 'widget_not_mounted',
      };
    }

    if (visibleWidgets.length > 1) {
      return {
        mounted: false,
        ambiguous: true,
        entries: [],
        script_name: null,
        script_selector: null,
        script_association: 'ambiguous',
        source_scope: 'widgetbar-widget-pine_logs',
        widget_count: widgets.length,
        visible_widget_count: visibleWidgets.length,
        reason: 'ambiguous_visible_pine_logs_widgets',
      };
    }
    var panel = visibleWidgets[0];

    var scope = scriptScope(panel);
    var records = [];
    var containers = Array.from(panel.querySelectorAll('div[class*="logContainer-"]'));
    for (var i = 0; i < containers.length; i++) {
      var messages = containers[i].querySelectorAll('span[class*="msg-"]');
      if (messages.length > 0) records.push({ container: containers[i], node: messages[0] });
    }

    var entries = [];
    for (var recordIndex = 0; recordIndex < records.length; recordIndex++) {
      var record = records[recordIndex];
      var text = (record.node.textContent || '').trim();
      if (!text) continue;
      var parsed = parseMessage(text);
      if (!parsed.message) continue;
      var level = levelFor(record.container, record.node);
      entries.push({
        timestamp: parsed.timestamp,
        type: level,
        level: level,
        message: parsed.message,
      });
    }
    return {
      mounted: true,
      entries: entries,
      script_name: scope.name,
      script_selector: scope.selector,
      script_association: scope.association,
      source_scope: 'widgetbar-widget-pine_logs',
      widget_count: widgets.length,
      visible_widget_count: visibleWidgets.length,
    };
  })()
`;

/**
 * Normalize entries returned by the structurally scoped Pine Logs expression.
 * The verified widget/row/message DOM path is the trust boundary; message
 * text is never classified as source merely because it contains Pine syntax.
 */
export function filterPineLogEntries(entries = []) {
  if (!Array.isArray(entries)) return [];
  return entries.map(entry => {
    if (!entry || typeof entry !== 'object') return null;
    const message = typeof entry.message === 'string' ? entry.message.trim() : '';
    if (!message) return null;
    const type = entry.type || entry.level || 'info';
    const level = entry.level ?? null;
    return {
      timestamp: entry.timestamp ?? null,
      type: String(type),
      level: level === null ? null : String(level),
      message,
    };
  }).filter(Boolean);
}

export async function getConsole(options = {}) {
  const deps = options._deps || {};
  const runEvaluate = deps.evaluate || evaluate;
  const ensureOptions = deps.ensureOptions
    ? { ...deps.ensureOptions }
    : { evaluate: runEvaluate };
  if (!ensureOptions.evaluate && deps.evaluate) ensureOptions.evaluate = runEvaluate;
  if (!ensureOptions.sleep && deps.sleep) ensureOptions.sleep = deps.sleep;

  const editorStatus = await ensurePineEditorOpenDetailed(ensureOptions);
  if (!editorStatus.ready) throw new Error(pineUnavailableMessage('Could not open Pine Editor', editorStatus));

  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const maxAttempts = Math.max(1, Number(deps.logMaxAttempts ?? deps.maxAttempts ?? 20));
  const intervalMs = Math.max(0, Number(deps.logIntervalMs ?? deps.intervalMs ?? 100));

  const finish = panel => {
    const entries = filterPineLogEntries(panel?.entries);
    return {
      success: true,
      entries,
      entry_count: entries.length,
      source_scope: 'widgetbar-widget-pine_logs',
      script_name: panel?.script_name || null,
      script_selector: panel?.script_selector || null,
      script_association: panel?.script_association || 'unknown',
    };
  };

  let panel = await runEvaluate(PINE_LOGS_READ_EXPRESSION);
  if (panel?.mounted) return finish(panel);
  if (panel?.ambiguous) {
    throw new Error(`Pine Logs could not be used: ${panel.reason || 'ambiguous_visible_pine_logs_widgets'}`);
  }

  const more = await runEvaluate(PINE_LOGS_OPEN_MORE_EXPRESSION);
  if (!more?.attempted) {
    throw new Error(`Pine Logs could not be opened: ${more?.reason || 'More control unavailable'}`);
  }

  let menu = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    menu = await runEvaluate(PINE_LOGS_OPEN_MENU_EXPRESSION);
    if (menu?.attempted) break;
    if (attempt < maxAttempts) await sleep(intervalMs);
  }
  if (!menu?.attempted) {
    throw new Error(`Pine Logs could not be opened: ${menu?.reason || 'Pine logs menu item unavailable'}`);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    panel = await runEvaluate(PINE_LOGS_READ_EXPRESSION);
    if (panel?.mounted) return finish(panel);
    if (panel?.ambiguous) {
      throw new Error(`Pine Logs could not be used: ${panel.reason || 'ambiguous_visible_pine_logs_widgets'}`);
    }
    if (attempt < maxAttempts) await sleep(intervalMs);
  }
  throw new Error(`Pine Logs could not be mounted after opening Pine logs: ${panel?.reason || 'widget_not_mounted'}`);
}

export async function smartCompile() {
  const editorStatus = await ensurePineEditorOpenDetailed();
  if (!editorStatus.ready) throw new Error(pineUnavailableMessage('Could not open Pine Editor', editorStatus));

  const studiesBefore = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const buttonClicked = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      var addBtn = null;
      var updateBtn = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!addBtn && /^add to chart$/i.test(text)) addBtn = btns[i];
        if (!updateBtn && /^update on chart$/i.test(text)) updateBtn = btns[i];
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) saveBtn = btns[i];
      }
      if (addBtn) { addBtn.click(); return 'Add to chart'; }
      if (updateBtn) { updateBtn.click(); return 'Update on chart'; }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  if (!buttonClicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2500));

  const errorResult = await runPineEditorOperation(`
    function(editor, env, model) {
      return env.editor.getModelMarkers({ resource: model.uri }).map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
  `);
  if (!errorResult?.ok) throw new Error(pineUnavailableMessage('Could not reacquire Pine Editor', errorResult));
  const errors = errorResult.value || [];

  const studiesAfter = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const studyAdded = (studiesBefore !== null && studiesAfter !== null) ? studiesAfter > studiesBefore : null;

  return {
    success: true,
    button_clicked: buttonClicked || 'keyboard_shortcut',
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
  };
}

export async function newScript({ type }) {
  const editorStatus = await ensurePineEditorOpenDetailed();
  if (!editorStatus.ready) throw new Error(pineUnavailableMessage('Could not open Pine Editor', editorStatus));

  const typeMap = { indicator: 'indicator', strategy: 'strategy', library: 'library' };
  const templates = {
    indicator: '//@version=6\nindicator("My script")\nplot(close)',
    strategy: '//@version=6\nstrategy("My strategy", overlay=true)\n',
    library: '//@version=6\n// @description TODO: add library description here\nlibrary("MyLibrary")\n',
  };

  const template = templates[type] || templates.indicator;

  // Simply set the source to a new template — this is the most reliable approach
  const escaped = JSON.stringify(template);
  const setResult = await runPineEditorOperation(
    `function(editor) { editor.setValue(${escaped}); return true; }`
  );

  if (!setResult?.ok || !setResult.value) throw new Error(pineUnavailableMessage('Could not set Pine source', setResult));

  return { success: true, type, action: 'new_script_created', template: typeMap[type] };
}

export async function openScript({ name }) {
  const editorStatus = await ensurePineEditorOpenDetailed();
  if (!editorStatus.ready) throw new Error(pineUnavailableMessage('Could not open Pine Editor', editorStatus));

  const escapedName = JSON.stringify(name.toLowerCase());

  const result = await evaluateAsync(`
    (function() {
      var target = ${escapedName};
      return fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(scripts) {
          if (!Array.isArray(scripts)) return {error: 'pine-facade returned unexpected data'};
          var match = null;
          for (var i = 0; i < scripts.length; i++) {
            var sn = (scripts[i].scriptName || '').toLowerCase();
            var st = (scripts[i].scriptTitle || '').toLowerCase();
            if (sn === target || st === target) { match = scripts[i]; break; }
          }
          if (!match) {
            for (var j = 0; j < scripts.length; j++) {
              var sn2 = (scripts[j].scriptName || '').toLowerCase();
              var st2 = (scripts[j].scriptTitle || '').toLowerCase();
              if (sn2.indexOf(target) !== -1 || st2.indexOf(target) !== -1) { match = scripts[j]; break; }
            }
          }
          if (!match) return {error: 'Script "' + target + '" not found. Use pine_list_scripts to see available scripts.'};

          var id = match.scriptIdPart;
          var ver = match.version || 1;
          return fetch('https://pine-facade.tradingview.com/pine-facade/get/' + id + '/' + ver, { credentials: 'include' })
            .then(function(r2) { return r2.json(); })
            .then(function(data) {
              var source = data.source || '';
              if (!source) return {error: 'Script source is empty', name: match.scriptName || match.scriptTitle};
              return {success: true, name: match.scriptName || match.scriptTitle, id: id, source: source};
            });
        })
        .catch(function(e) { return {error: e.message}; });
    })()
  `);

  if (result?.error) {
    throw new Error(result.error);
  }

  const escapedSource = JSON.stringify(result.source);
  const setResult = await runPineEditorOperation(
    `function(editor) { editor.setValue(${escapedSource}); return true; }`
  );
  if (!setResult?.ok || !setResult.value) {
    throw new Error(pineUnavailableMessage('Could not set Pine source', setResult));
  }

  return { success: true, name: result.name, script_id: result.id, lines: result.source.split('\n').length, source: 'internal_api', opened: true };
}

export async function listScripts() {
  const scripts = await evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!Array.isArray(data)) return {scripts: [], error: 'Unexpected response from pine-facade'};
        return {
          scripts: data.map(function(s) {
            return {
              id: s.scriptIdPart || null,
              name: s.scriptName || s.scriptTitle || 'Untitled',
              title: s.scriptTitle || null,
              version: s.version || null,
              modified: s.modified || null,
            };
          })
        };
      })
      .catch(function(e) { return {scripts: [], error: e.message}; })
  `);

  return {
    success: true,
    scripts: scripts?.scripts || [],
    count: scripts?.scripts?.length || 0,
    source: 'internal_api',
    error: scripts?.error,
  };
}
