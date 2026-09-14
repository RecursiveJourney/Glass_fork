// Keep keyed DOM nodes and the reader's visual anchor across corrections/reordering/eviction.
// All payload content is assigned through textContent by the caller.
export function updateFeedRows(container, rows, cache, keyOf, create, update, reset = false) {
    const bottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 12;
    const top = container.getBoundingClientRect().top;
    const anchor = [...container.children].find(node => node.dataset.rowKey && node.getBoundingClientRect().bottom > top);
    const anchorKey = anchor?.dataset.rowKey;
    const offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
    const oldTop = container.scrollTop;
    if (reset) { cache.clear(); container.replaceChildren(); }
    const retained = new Set();
    for (const row of rows) {
        const key = keyOf(row); retained.add(key);
        let node = cache.get(key);
        if (!node) { node = create(); node.dataset.rowKey = key; cache.set(key, node); }
        update(node, row);
        container.append(node);
    }
    for (const [key, node] of cache) if (!retained.has(key)) { node.remove(); cache.delete(key); }
    if (reset || bottom) container.scrollTop = container.scrollHeight;
    else {
        const target = cache.get(anchorKey);
        container.scrollTop = target ? container.scrollTop + target.getBoundingClientRect().top - top - offset : oldTop;
    }
}
