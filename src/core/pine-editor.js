import { evaluate } from '../connection.js';

// These expressions are internal implementation details. Keeping them in this
// module lets unit tests exercise the exact code injected into TradingView
// without adding test-only exports to the public Pine API.
export const RESOLVE_PINE_EDITOR = `
  (function resolvePineEditor() {
    function isConnected(node) {
      return !!(node && node.isConnected && document.documentElement && document.documentElement.contains(node));
    }
    function isLayoutVisible(node) {
      if (!isConnected(node)) return false;
      var rect = node.getBoundingClientRect();
      var style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) !== 0;
    }
    function isVisiblePineUi(node) {
      if (!isLayoutVisible(node)) return false;
      var marker = ((node.getAttribute && node.getAttribute('data-name')) || '')
        + ' ' + (typeof node.className === 'string' ? node.className : '');
      if (/pine[-_ ]?(dialog|editor)/i.test(marker)) return true;
      var title = node.querySelector && node.querySelector('h1, h2, h3, [class*="title"]');
      return !!(title && /^Pine Editor$/i.test((title.textContent || '').trim()));
    }
    function visiblePineUis() {
      return Array.from(document.querySelectorAll(
        '[role="dialog"], [data-name="pine-dialog"], [class*="pine-dialog"], [class*="pineEditor"], .pine-editor-container'
      )).filter(isVisiblePineUi);
    }
    function associatedWithVisibleUi(container, uiNodes) {
      for (var i = 0; i < uiNodes.length; i++) {
        if (uiNodes[i] === container || uiNodes[i].contains(container)) return true;
      }
      return false;
    }
    function isDisposed(value) {
      try {
        if (!value) return false;
        if (value._isDisposed === true || value._disposed === true) return true;
        return !!(typeof value.isDisposed === 'function' && value.isDisposed());
      }
      catch (error) { return true; }
    }
    function addEnvironment(environments, candidate) {
      if (!candidate || !candidate.editor || typeof candidate.editor.getEditors !== 'function') return;
      if (environments.indexOf(candidate) === -1) environments.push(candidate);
    }
    function environmentsFor(container) {
      var environments = [];
      var starts = [];
      var element = container;
      for (var parentDepth = 0; element && parentDepth < 30; parentDepth++, element = element.parentElement) {
        var keys = Object.keys(element).filter(function(key) { return key.startsWith('__reactFiber$'); });
        for (var keyIndex = 0; keyIndex < keys.length; keyIndex++) {
          var fiber = element[keys[keyIndex]];
          if (fiber && starts.indexOf(fiber) === -1) starts.push(fiber);
        }
      }

      var queue = starts.slice();
      var visited = [];
      var traversed = 0;
      while (queue.length > 0 && traversed < 160) {
        var current = queue.shift();
        if (!current || visited.indexOf(current) !== -1) continue;
        visited.push(current);
        traversed++;

        var memoized = current.memoizedProps;
        var pending = current.pendingProps;
        addEnvironment(environments, memoized && memoized.value && memoized.value.monacoEnv);
        addEnvironment(environments, memoized && memoized.monacoEnv);
        addEnvironment(environments, pending && pending.value && pending.value.monacoEnv);
        addEnvironment(environments, pending && pending.monacoEnv);

        if (current.return) queue.push(current.return);
        if (current.alternate) queue.push(current.alternate);
      }
      return environments;
    }
    function editorDomNode(editor) {
      try {
        if (editor && typeof editor.getDomNode === 'function') {
          var domNode = editor.getDomNode();
          if (domNode) return domNode;
        }
        if (editor && typeof editor.getContainerDomNode === 'function') return editor.getContainerDomNode();
      } catch (error) {}
      return null;
    }

    var uiNodes = visiblePineUis();
    var allContainers = Array.from(document.querySelectorAll('.monaco-editor.pine-editor-monaco'));
    var visibleContainers = allContainers.filter(isLayoutVisible);
    var candidateContainers = uiNodes.length > 0
      ? visibleContainers.filter(function(container) { return associatedWithVisibleUi(container, uiNodes); })
      : visibleContainers;

    var base = {
      containerCount: allContainers.length,
      visibleContainerCount: visibleContainers.length,
      candidateContainerCount: candidateContainers.length,
      pineUiVisible: uiNodes.length > 0,
    };

    if (candidateContainers.length === 0) {
      if (uiNodes.length > 0) return Object.assign(base, { state: 'monaco_mount_pending' });
      return Object.assign(base, { state: 'pine_ui_absent' });
    }

    var sawEnvironment = false;
    var sawEditors = false;
    var sawExactEditor = false;
    var sawModelAbsent = false;
    var editorCount = 0;
    var viable = [];
    for (var containerIndex = 0; containerIndex < candidateContainers.length; containerIndex++) {
      var container = candidateContainers[containerIndex];
      var environments = environmentsFor(container);
      if (environments.length > 0) sawEnvironment = true;

      for (var envIndex = 0; envIndex < environments.length; envIndex++) {
        var env = environments[envIndex];
        var editors = [];
        try { editors = env.editor.getEditors() || []; } catch (error) { editors = []; }
        editorCount = Math.max(editorCount, editors.length);
        if (editors.length > 0) sawEditors = true;

        for (var editorIndex = 0; editorIndex < editors.length; editorIndex++) {
          var editor = editors[editorIndex];
          if (isDisposed(editor) || editorDomNode(editor) !== container) continue;
          sawExactEditor = true;

          var model = null;
          try { model = typeof editor.getModel === 'function' ? editor.getModel() : null; } catch (error) {}
          if (!model || isDisposed(model)) {
            sawModelAbsent = true;
            continue;
          }

          var duplicate = viable.some(function(item) {
            return item.editor === editor && item.container === container;
          });
          if (!duplicate) viable.push({ container: container, editor: editor, env: env, model: model });
        }
      }
    }

    base.editorCount = editorCount;
    if (viable.length === 1) {
      return Object.assign(base, viable[0], { state: 'ready' });
    }
    if (viable.length > 1) {
      return Object.assign(base, { state: 'ambiguous_editor', viableEditorCount: viable.length });
    }
    if (!sawEnvironment) return Object.assign(base, { state: 'monaco_env_absent' });
    if (!sawEditors) return Object.assign(base, { state: 'editors_empty' });
    if (sawExactEditor && sawModelAbsent) return Object.assign(base, { state: 'model_absent' });
    return Object.assign(base, { state: uiNodes.length > 0 ? 'monaco_mount_pending' : 'no_matching_visible_editor' });
  })()
`;

export const PINE_STATE_EXPRESSION = `
  /* PINE_EDITOR_STATE */
  (function() {
    var resolved = ${RESOLVE_PINE_EDITOR};
    return {
      state: resolved.state,
      pine_ui_visible: !!resolved.pineUiVisible,
      container_count: resolved.containerCount || 0,
      visible_container_count: resolved.visibleContainerCount || 0,
      candidate_container_count: resolved.candidateContainerCount || 0,
      editor_count: resolved.editorCount || 0,
      viable_editor_count: resolved.viableEditorCount || (resolved.state === 'ready' ? 1 : 0),
    };
  })()
`;

export const OPEN_PINE_EDITOR_EXPRESSION = `
  /* OPEN_PINE_EDITOR */
  (function() {
    function isVisible(node) {
      if (!node || !node.isConnected) return false;
      var rect = node.getBoundingClientRect();
      var style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) !== 0;
    }
    function unwrap(value) {
      try { return value && typeof value.value === 'function' ? value.value() : value; }
      catch (error) { return null; }
    }

    var controls = Array.from(document.querySelectorAll('[aria-label="Pine"], [data-name="pine-dialog-button"]'));
    var button = controls.find(isVisible);
    if (button) {
      button.click();
      return { attempted: true, method: 'pine_button' };
    }

    var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
    if (!bwb || typeof bwb.activateScriptEditorTab !== 'function') {
      return { attempted: false, method: null, reason: 'no_open_control' };
    }

    var bottomVisible = typeof bwb.isVisible === 'function' && !!unwrap(bwb.isVisible());
    var names = ['pine-editor', 'script-editor'];
    var usableName = null;
    for (var i = 0; i < names.length; i++) {
      try {
        var enabled = typeof bwb.isWidgetEnabled === 'function' && bwb.isWidgetEnabled(names[i]);
        var present = typeof bwb.getWidgetByName === 'function' && !!bwb.getWidgetByName(names[i]);
        if (enabled && present) { usableName = names[i]; break; }
      } catch (error) {}
    }
    if (bottomVisible && usableName) {
      bwb.activateScriptEditorTab();
      return { attempted: true, method: 'bottom_widget_bar', widget_name: usableName };
    }
    return { attempted: false, method: null, reason: 'legacy_bottom_bar_unusable' };
  })()
`;

export const CLOSE_PINE_EDITOR_EXPRESSION = `
  /* CLOSE_PINE_EDITOR */
  (function() {
    function isVisible(node) {
      if (!node || !node.isConnected) return false;
      var rect = node.getBoundingClientRect();
      var style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0
        && style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) !== 0;
    }
    function isPineUi(node) {
      if (!isVisible(node)) return false;
      var marker = ((node.getAttribute && node.getAttribute('data-name')) || '')
        + ' ' + (typeof node.className === 'string' ? node.className : '');
      if (/pine[-_ ]?(dialog|editor)/i.test(marker)) return true;
      var title = node.querySelector && node.querySelector('h1, h2, h3, [class*="title"]');
      return !!(title && /^Pine Editor$/i.test((title.textContent || '').trim()));
    }
    var dialogs = Array.from(document.querySelectorAll(
      '[role="dialog"], [data-name="pine-dialog"], [class*="pine-dialog"], [class*="pineEditor"], .pine-editor-container'
    )).filter(isPineUi);
    for (var i = 0; i < dialogs.length; i++) {
      var controls = Array.from(dialogs[i].querySelectorAll(
        'button[aria-label="Close"], [role="button"][aria-label="Close"], button[data-name="close"], [data-name="close"]'
      ));
      var closeButton = controls.find(isVisible);
      if (closeButton) {
        closeButton.click();
        return { attempted: true, method: 'pine_dialog_close' };
      }
    }
    return { attempted: false, method: null, reason: dialogs.length ? 'no_semantic_close_control' : 'no_visible_pine_dialog' };
  })()
`;

export async function getPineEditorStateDetailed(options = {}) {
  const runEvaluate = options.evaluate || evaluate;
  return runEvaluate(PINE_STATE_EXPRESSION);
}

export async function ensurePineEditorOpenDetailed(options = {}) {
  const runEvaluate = options.evaluate || evaluate;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? 50;
  const intervalMs = options.intervalMs ?? 200;

  let state = await getPineEditorStateDetailed({ evaluate: runEvaluate });
  if (state.state === 'ready') return { ready: true, ...state, opened_with: null, attempts: 0 };

  let openResult = null;
  if (state.state === 'pine_ui_absent') {
    openResult = await runEvaluate(OPEN_PINE_EDITOR_EXPRESSION);
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(intervalMs);
    state = await getPineEditorStateDetailed({ evaluate: runEvaluate });
    if (state.state === 'ready') {
      return { ready: true, ...state, opened_with: openResult?.method || null, attempts: attempt };
    }
  }

  return {
    ready: false,
    ...state,
    opened_with: openResult?.method || null,
    open_attempted: openResult?.attempted || false,
    open_failure: openResult?.reason || null,
    attempts: maxAttempts,
  };
}

export async function runPineEditorOperation(operationExpression, options = {}) {
  const runEvaluate = options.evaluate || evaluate;
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? 3;
  const intervalMs = options.intervalMs ?? 100;
  let lastResult = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResult = await runEvaluate(`
      /* PINE_EDITOR_OPERATION */
      (function() {
        function disposed(value) {
          try {
            if (!value) return false;
            if (value._isDisposed === true || value._disposed === true) return true;
            return !!(typeof value.isDisposed === 'function' && value.isDisposed());
          }
          catch (error) { return true; }
        }
        function visible(node) {
          if (!node || !node.isConnected || !document.documentElement.contains(node)) return false;
          var rect = node.getBoundingClientRect();
          var style = getComputedStyle(node);
          return rect.width > 0 && rect.height > 0
            && style.display !== 'none'
            && style.visibility !== 'hidden'
            && Number(style.opacity || 1) !== 0;
        }
        function editorDomNode(editor) {
          try {
            if (editor && typeof editor.getDomNode === 'function') {
              var domNode = editor.getDomNode();
              if (domNode) return domNode;
            }
            if (editor && typeof editor.getContainerDomNode === 'function') return editor.getContainerDomNode();
          } catch (error) {}
          return null;
        }
        var resolved = ${RESOLVE_PINE_EDITOR};
        if (resolved.state !== 'ready') return { ok: false, state: resolved.state };

        var currentModel = null;
        try { currentModel = resolved.editor.getModel(); } catch (error) {}
        if (!visible(resolved.container) || editorDomNode(resolved.editor) !== resolved.container
            || disposed(resolved.editor) || !currentModel || currentModel !== resolved.model || disposed(currentModel)) {
          return { ok: false, state: 'operation_stale' };
        }

        try {
          return {
            ok: true,
            value: (${operationExpression})(resolved.editor, resolved.env, currentModel, resolved.container),
            model_uri: currentModel.uri && currentModel.uri.toString ? currentModel.uri.toString() : null,
          };
        } catch (error) {
          var message = error && error.message ? error.message : String(error);
          if (/disposed|detached|destroyed|invalid.*model/i.test(message)) {
            return { ok: false, state: 'operation_stale', error: message };
          }
          return { ok: false, state: 'operation_error', error: message };
        }
      })()
    `);

    if (lastResult?.ok) return lastResult;
    if (lastResult?.state === 'operation_error') break;
    if (attempt < maxAttempts) await sleep(intervalMs);
  }
  return lastResult || { ok: false, state: 'unknown' };
}
