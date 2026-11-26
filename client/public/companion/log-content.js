/* Present the existing Ludens block kinds; source text is always inserted as text. */
function renderLogContent(target, input, copy) {
  const block = input.block;
  const kind = block?.kind ?? 'text';
  const id = block?.id ?? input.id;
  const same = target.dataset.blockId === id;
  const oldBody = target.querySelector('.log-body');
  const scrollTop = same ? oldBody?.scrollTop ?? 0 : 0;
  const resultOpen = same ? target.querySelector('details')?.open : undefined;
  const focused = same && target.querySelector('summary') === document.activeElement;
  const bodyFocused = same && oldBody === document.activeElement;
  function el(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function format(value) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
  function formatToolArgs(args) {
    if (args == null) return '';
    if (typeof args === 'string') return args.trim() ? args : '';
    if (Array.isArray(args)) return args.length ? JSON.stringify(args, null, 2) : '';
    if (typeof args === 'object') {
      const keys = Object.keys(args);
      if (!keys.length) return '';
      if (typeof args.command === 'string') {
        const cmd = args.command.trim();
        const extraKeys = keys.filter(k =>
          k !== 'command' && args[k] !== undefined && args[k] !== null && (typeof args[k] !== 'string' || args[k].trim() !== ''));
        if (!cmd && !extraKeys.length) return '';
        if (cmd && !extraKeys.length) return `$ ${cmd}`;
        const extras = extraKeys.map(k => `# ${k}: ${typeof args[k] === 'string' ? args[k] : JSON.stringify(args[k])}`);
        return cmd ? `$ ${cmd}\n${extras.join('\n')}` : extras.join('\n');
      }
      const json = JSON.stringify(args, null, 2);
      return json && json !== '{}' ? json : '';
    }
    return String(args);
  }
  function formatToolResult(result) {
    if (result == null) return '';
    if (typeof result === 'string') return result.trim() ? result : '';
    if (Array.isArray(result)) return result.length ? JSON.stringify(result, null, 2) : '';
    if (typeof result === 'object') {
      const keys = Object.keys(result);
      if (!keys.length) return '';
      const shellKeys = new Set(['stdout', 'stderr', 'exitCode', 'output', 'code']);
      if (keys.every(k => shellKeys.has(k))) {
        const parts = [];
        for (const field of ['stdout', 'output', 'stderr']) {
          if (typeof result[field] === 'string' && result[field].trim()) parts.push(result[field].trimEnd());
        }
        const exit = typeof result.exitCode === 'number' ? result.exitCode
          : typeof result.code === 'number' ? result.code : undefined;
        if (exit !== undefined && exit !== 0) parts.push(`exit ${exit}`);
        return parts.join('\n');
      }
      if (Array.isArray(result.content)) {
        return result.content
          .map(item => (item && typeof item.text === 'string' ? item.text.trimEnd() : ''))
          .filter(text => text.trim().length > 0)
          .join('\n');
      }
      const json = JSON.stringify(result, null, 2);
      return json && json !== '{}' ? json : '';
    }
    return String(result);
  }
  const paths = {
    thinking: 'M5 16a4 4 0 0 1-1-7.8A5 5 0 0 1 13 5a4 4 0 0 1 6 3 4 4 0 0 1-1 8H5M6 20h.01M3 22h.01',
    text: 'M4 4h16v12H9l-5 4V4m4 4h8m-8 4h5',
    tool: 'm5 6 5 6-5 6m8 0h6',
    system: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18m-4 9 3 3 5-6',
    diagnostic: 'M5 20v-7m7 7V4m7 16V9',
  };
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('class', 'log-icon');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(icon.namespaceURI, 'path');
  path.setAttribute('d', paths[kind]);
  icon.append(path);
  let title = block?.title ?? input.title;
  if (id === 'connected:manual') {
    if (title === '本轮已结束，控制权已收回') title = copy.returned;
    else if (title === '已连接 · 手动待命') title = copy.waiting;
  }
  const header = el('div', 'log-header');
  const heading = el('span', 'log-title', title);
  heading.title = title;
  header.append(icon, heading);
  const status = block?.status ?? input.status;
  if (kind === 'tool' || status === 'error') {
    header.append(el('span', 'log-status', status === 'running' ? copy.running : status === 'error' ? copy.error : copy.complete));
  } else if (status === 'running') {
    const dots = el('span', 'log-stream', '•••');
    dots.setAttribute('aria-label', copy.generating);
    header.append(dots);
  }
  const content = el('div', 'log-body');
  content.tabIndex = 0;
  content.setAttribute('role', 'region');
  content.setAttribute('aria-label', copy.content.replace('{title}', title));
  if (kind === 'tool' && block.tool) {
    const tool = block.tool;
    if (typeof tool.intent === 'string' && tool.intent.trim()) content.append(el('p', 'log-intent', tool.intent));
    const formattedArgs = formatToolArgs(tool.args);
    if (formattedArgs.trim().length > 0) {
      const args = el('pre', 'log-code', formattedArgs);
      args.setAttribute('aria-label', copy.arguments);
      content.append(args);
    }
    const hasLeadingContext = Boolean(
      (typeof tool.intent === 'string' && tool.intent.trim()) || formattedArgs.trim().length > 0,
    );
    const formattedResult = formatToolResult(tool.result);
    if (formattedResult.trim().length > 0) {
      const details = el('details', 'log-result');
      details.open = resultOpen ?? (status === 'error' || !hasLeadingContext);
      const summary = el('summary', '', copy.result);
      summary.addEventListener('click', event => {
        event.preventDefault();
        details.open = !details.open;
        if (details.open) content.scrollTop += details.getBoundingClientRect().top - content.getBoundingClientRect().top;
      });
      details.append(summary, el('pre', 'log-code', formattedResult));
      content.append(details);
    }
    if (content.childElementCount === 0 && status === 'running') {
      content.append(el('p', 'log-pending', copy.executing));
    }
  } else if ((kind === 'system' || kind === 'diagnostic') && block.data && Object.keys(block.data).length) {
    if (kind === 'system' && block.title === 'control') {
      const label = { auto: copy.aiControl, manual: copy.manualControl }[block.data.mode];
      if (label) content.append(el('p', 'log-event', label));
    }
    const fields = el('dl', 'log-fields');
    for (const [key, value] of Object.entries(block.data)) {
      fields.append(el('dt', '', key), el('dd', '', format(value)));
    }
    content.append(fields);
  } else if (kind === 'tool' && !(block?.text ?? input.description ?? '').trim()) {
    if (status === 'running') content.append(el('p', 'log-pending', copy.executing));
  } else {
    content.append(el('p', 'log-prose', block?.text ?? input.description ?? ''));
  }
  target.dataset.kind = kind;
  target.dataset.status = status;
  target.dataset.blockId = id;
  target.replaceChildren(header, content);
  content.scrollTop = scrollTop;
  if (focused) target.querySelector('summary')?.focus({ preventScroll: true });
  else if (bodyFocused) content.focus({ preventScroll: true });
}
