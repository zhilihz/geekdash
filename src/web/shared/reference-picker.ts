const pickers = new WeakMap<HTMLSelectElement, () => void>();

export function mountReferencePickers(root: ParentNode = document) {
  root.querySelectorAll<HTMLSelectElement>('select[data-reference="true"]').forEach(source => {
    if (pickers.has(source)) return;
    const doc = source.ownerDocument;
    const id = source.id.replace(/-source$/, '');
    const title = source.closest('.field')?.querySelector('label')?.textContent?.trim() || '资料';
    const wrapper = doc.createElement('div'); wrapper.className = 'reference-picker';
    const box = doc.createElement('div'); box.className = 'reference-box';
    const values = doc.createElement('div'); values.className = 'reference-values';
    const chips = doc.createElement('span'); chips.className = 'reference-chips';
    const input = doc.createElement('input');
    input.id = id; input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
    input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-controls', id + '-choices');
    input.setAttribute('aria-label', title);
    const error = source.closest('.field')?.querySelector('.field-error');
    if (error?.id) input.setAttribute('aria-describedby', error.id);
    const clear = doc.createElement('button'); clear.type = 'button'; clear.textContent = '×';
    clear.dataset.referenceClear = ''; clear.setAttribute('aria-label', '清空' + title);
    const toggle = doc.createElement('button'); toggle.type = 'button'; toggle.textContent = '▾';
    toggle.dataset.referenceToggle = ''; toggle.setAttribute('aria-label', '展开' + title + '候选');
    const list = doc.createElement('div'); list.id = id + '-choices'; list.className = 'reference-options';
    list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', title + '候选'); list.hidden = true;
    if (source.multiple) list.setAttribute('aria-multiselectable', 'true');
    values.append(chips, input); box.append(values, clear, toggle); wrapper.append(box, list);
    source.hidden = true; source.after(wrapper);
    let query = '', opened = false, active = -1, selection = '', renderedOptions = '';
    let candidates: HTMLButtonElement[] = [];
    const selected = () => [...source.selectedOptions].filter(option => option.value);
    const optionState = () => JSON.stringify([...source.options].map(option => [option.value, option.textContent, option.selected, option.disabled]));
    const optionTitle = (option: HTMLOptionElement) => option.textContent?.trim() || option.value;
    const displayTitle = (option: HTMLOptionElement) => [...source.options].filter(other => other.value && optionTitle(other) === optionTitle(option)).length > 1 ? `${optionTitle(option)} · #${option.value}` : optionTitle(option);
    function highlight(index: number) {
      active = index;
      candidates.forEach((button, i) => button.classList.toggle('is-active', i === index));
      if (candidates[index]) { input.setAttribute('aria-activedescendant', candidates[index].id); candidates[index].scrollIntoView?.({ block: 'nearest' }); }
      else input.removeAttribute('aria-activedescendant');
    }
    function close() {
      opened = false; query = ''; list.hidden = true; wrapper.classList.remove('is-open');
      input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
      toggle.setAttribute('aria-label', '展开' + title + '候选');
      input.value = source.multiple ? '' : selected().map(displayTitle).join('');
    }
    function changed() {
      source.dispatchEvent(new Event('change', { bubbles: true }));
      sync();
    }
    function choose(option: HTMLOptionElement) {
      if (source.disabled || option.disabled) return;
      if (source.multiple) option.selected = !option.selected;
      else source.value = option.value;
      query = ''; input.value = '';
      if (!source.multiple) close();
      changed();
      if (source.multiple && !source.disabled) open();
    }
    function renderOptions() {
      renderedOptions = optionState();
      list.replaceChildren(); candidates = [];
      const needle = query.trim().toLocaleLowerCase();
      for (const option of source.options) {
        if (!option.value || !displayTitle(option).toLocaleLowerCase().includes(needle)) continue;
        const button = doc.createElement('button'); button.type = 'button'; button.tabIndex = -1;
        button.id = id + '-option-' + candidates.length; button.dataset.referenceValue = option.value;
        button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(option.selected));
        button.disabled = option.disabled; button.textContent = displayTitle(option);
        if (option.selected) button.classList.add('is-selected');
        button.onmousedown = event => event.preventDefault(); button.onclick = () => choose(option);
        list.append(button); candidates.push(button);
      }
      if (!candidates.length) {
        const empty = doc.createElement('div'); empty.className = 'reference-empty'; empty.setAttribute('role', 'status');
        empty.textContent = query ? '没有匹配资料，可修改搜索内容；原选择保留。' : '暂无可选资料。'; list.append(empty);
      }
      highlight(-1);
    }
    function open() {
      if (source.disabled) return;
      opened = true; list.hidden = false; wrapper.classList.add('is-open');
      input.setAttribute('aria-expanded', 'true'); toggle.setAttribute('aria-label', '收起' + title + '候选'); renderOptions();
    }
    function sync() {
      const current = selected();
      input.disabled = source.disabled; clear.disabled = source.disabled; toggle.disabled = source.disabled;
      wrapper.classList.toggle('is-disabled', source.disabled);
      clear.hidden = !current.length;
      input.placeholder = source.multiple ? '输入搜索或选择' : '未选择，输入搜索';
      const signature = JSON.stringify(current.map(option => [option.value, option.textContent]));
      if (signature !== selection) {
        selection = signature; chips.replaceChildren();
        if (source.multiple) for (const option of current) {
          const chip = doc.createElement('span'); chip.className = 'reference-chip';
          const name = doc.createElement('span'); name.textContent = displayTitle(option);
          const remove = doc.createElement('button'); remove.type = 'button'; remove.textContent = '×';
          remove.dataset.referenceRemove = option.value; remove.setAttribute('aria-label', '移除' + displayTitle(option));
          remove.onmousedown = event => event.preventDefault(); remove.onclick = () => { if (source.disabled) return; option.selected = false; changed(); };
          chip.append(name, remove); chips.append(chip);
        }
      }
      chips.querySelectorAll('button').forEach(button => button.disabled = source.disabled);
      if (source.disabled) close();
      else if (opened) { if (renderedOptions !== optionState()) renderOptions(); }
      else input.value = source.multiple ? '' : current.map(displayTitle).join('');
    }
    input.onfocus = () => { query = ''; open(); if (!source.multiple) input.select(); };
    input.onclick = () => { if (!opened) { query = ''; open(); } };
    input.oninput = () => { query = input.value; open(); };
    input.onkeydown = event => {
      if (event.isComposing || source.disabled) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); if (!opened) { query = ''; open(); }
        const step = event.key === 'ArrowDown' ? 1 : -1;
        let next = active < 0 ? (step > 0 ? 0 : candidates.length - 1) : active + step;
        while (next >= 0 && next < candidates.length && candidates[next].disabled) next += step;
        if (next >= 0 && next < candidates.length) highlight(next);
      } else if (event.key === 'Enter') {
        event.preventDefault(); if (opened && active >= 0) candidates[active]?.click();
      }
    };
    for (const button of [clear, toggle]) button.onmousedown = event => event.preventDefault();
    clear.onclick = () => {
      if (source.disabled) return;
      for (const option of source.options) option.selected = false;
      if (!source.multiple) source.value = '';
      query = ''; input.value = ''; changed();
    };
    toggle.onclick = () => {
      if (source.disabled) return;
      if (opened) close(); else { input.focus(); query = ''; open(); }
    };
    wrapper.addEventListener('focusout', () => queueMicrotask(() => { if (!wrapper.contains(doc.activeElement)) close(); }));
    source.addEventListener('change', sync); pickers.set(source, sync); sync();
  });
}

export function syncReferencePickers(root: ParentNode = document) {
  root.querySelectorAll<HTMLSelectElement>('select[data-reference="true"]').forEach(source => pickers.get(source)?.());
}
