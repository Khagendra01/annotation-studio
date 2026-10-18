'use strict';

// A small illustrative dataset, evaluated by the same selector as real threads.
// Nothing here changes project data; presets only fill the adjacent inputs.
window.FilterPreview = (() => {
  const examples = [
    { title: 'Post 1 · Evacuation help', rows: [
      { node_id: 'p1', parent_id: '', role: 'op', text: 'Where can we find shelter?', level: 0 },
      { node_id: 'a', parent_id: 'p1', text: 'A · Try the community center', level: 1 },
      { node_id: 'a1', parent_id: 'a', text: 'A.1 · Is it open tonight?', level: 2 },
      { node_id: 'a2', parent_id: 'a1', text: 'A.1.1 · Yes, all night', level: 3 },
      { node_id: 'b', parent_id: 'p1', text: 'B · I can offer a ride', level: 1 },
    ] },
    { title: 'Post 2 · Supply drop-off', rows: [
      { node_id: 'p2', parent_id: '', role: 'op', text: 'Where can I donate supplies?', level: 0 },
      { node_id: 'c', parent_id: 'p2', text: 'C · The library accepts donations', level: 1 },
      { node_id: 'd', parent_id: 'p2', text: 'D · They need water and blankets', level: 1 },
    ] },
  ];
  const get = (key, row) => row[key] || '';
  const containers = [...document.querySelectorAll('[data-filter-preview]')];
  function refresh(prefix) {
    const host = containers.find(container => container.dataset.filterPreview === prefix);
    if (!host) return;
    const depthInput = document.getElementById(prefix + '-depth');
    const totalInput = document.getElementById(prefix + '-total');
    const caps = AnnotationScope.normalize({ depth: depthInput.value, total: totalInput.value });
    let included = 0;
    const threads = examples.map(example => {
      const eligible = new Set(AnnotationScope.select(example.rows, get, { depth: caps.depth }).rows.map(row => row.node_id));
      const selected = AnnotationScope.select(example.rows, get, caps);
      included += selected.comments;
      const selectedIds = new Set(selected.rows.map(row => row.node_id));
      return `<div class="preview-thread"><div class="preview-thread-title">${example.title}<span>${selected.comments} included</span></div><ol class="preview-tree">${example.rows.map(row => {
        const kept = selectedIds.has(row.node_id), post = row.role === 'op';
        const reason = kept ? (post ? 'The post · free' : row.level === 1 ? 'Comment' : `Reply · level ${row.level}`) : (!eligible.has(row.node_id) ? 'Deeper than your depth' : 'Max comments reached');
        return `<li class="preview-node ${kept ? 'included' : 'excluded'} ${post ? 'preview-post' : ''}" style="--level:${row.level}"><span class="preview-dot" aria-hidden="true">${kept ? '✓' : '−'}</span><span class="preview-node-text">${row.text}<small>${reason}</small></span></li>`;
      }).join('')}</ol></div>`;
    }).join('');
    host.innerHTML = `<div class="preview-heading"><div><span class="eyebrow">SEE HOW IT WORKS</span><h3>Your filters, visualized</h3></div><span class="preview-example">Illustrative example</span></div>
      <p class="preview-explainer">Depth = how many levels you see under each post (1 = its comments, 2 = also their replies). Max comments = how many comments + replies one post may show — each post has its own allowance.</p>
      <div class="preview-presets" aria-label="Try example filter values"><span>Try it:</span><button type="button" data-preset="depth" aria-label="Show only the comments directly under each post">Levels 1</button><button type="button" data-preset="total" aria-label="Allow each post up to 3 comments and replies">Max 3</button><button type="button" data-preset="all" aria-label="Remove all limits">Unlimited</button></div>
      <div class="preview-threads">${threads}</div>
      <div class="preview-summary" id="${prefix}-preview-summary" role="status" aria-live="polite"><strong>${included} of 6 example comments included</strong><span>✓ Included <span class="preview-legend-hidden">− Hidden by filters</span> · Posts don’t count</span></div>`;
    depthInput.setAttribute('aria-describedby', prefix + '-preview-summary');
    totalInput.setAttribute('aria-describedby', prefix + '-preview-summary');
  }
  for (const host of containers) {
    const prefix = host.dataset.filterPreview;
    for (const field of ['depth', 'total']) document.getElementById(prefix + '-' + field).addEventListener('input', () => refresh(prefix));
    host.addEventListener('click', event => {
      const button = event.target.closest('[data-preset]');
      if (!button) return;
      document.getElementById(prefix + '-depth').value = button.dataset.preset === 'depth' ? '1' : '';
      document.getElementById(prefix + '-total').value = button.dataset.preset === 'total' ? '3' : '';
      refresh(prefix);
      // Preserve keyboard focus when the preset buttons are rebuilt.
      host.querySelector(`[data-preset="${button.dataset.preset}"]`).focus({ preventScroll: true });
    });
    refresh(prefix);
  }
  return { refresh };
})();
