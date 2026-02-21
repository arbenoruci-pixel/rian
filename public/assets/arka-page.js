(function () {
  if (typeof window === 'undefined') return;

  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else n.setAttribute(k, v);
    });
    children.forEach(c => n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return n;
  }

  function render() {
    const root = document.getElementById('arkaApp');
    if (!root) return;
    root.innerHTML = '';

    const api = window.TepihaArka;
    if (!api) {
      root.appendChild(el('div', { html: 'ARKA engine missing (arka.js not loaded).' }));
      return;
    }

    const cur = api.getCurrentUser();
    root.appendChild(el('div', { html: `<b>ARKA</b> — ${cur?.name ? (cur.name + ' (' + cur.role + ')') : 'JO I KYÇUR'}` }));

    const pin = el('input', { type: 'password', placeholder: 'PIN', style: 'padding:10px;font-size:16px;width:140px;margin-top:10px;' });
    const btn = el('button', { style: 'padding:10px 12px;font-size:14px;cursor:pointer;margin-left:8px;' }, ['HYJ']);
    btn.onclick = () => {
      const res = api.handleLogin(pin.value);
      if (!res.success) alert(res.message || 'PIN gabim');
      render();
    };

    root.appendChild(el('div', { style: 'display:flex;align-items:center;margin:10px 0;' }, [pin, btn]));

    if (cur?.role === 'ADMIN') {
      const name = el('input', { placeholder: 'EMRI', style: 'padding:10px;font-size:14px;width:160px;' });
      const upin = el('input', { type: 'password', placeholder: 'PIN', style: 'padding:10px;font-size:14px;width:120px;' });
      const role = el('select', { style: 'padding:10px;font-size:14px;' }, api.ROLES.map(r => el('option', { value: r }, [r])));
      const add = el('button', { style: 'padding:10px 12px;font-size:14px;cursor:pointer;' }, ['SHTO PËRDORUES']);
      add.onclick = () => {
        const res = api.manageUsers('ADD', { name: name.value, pin: upin.value, role: role.value });
        if (!res.success) alert(res.message || 'Gabim');
        name.value = ''; upin.value = '';
        render();
      };

      root.appendChild(el('div', { style: 'display:flex;gap:10px;align-items:center;margin:12px 0;flex-wrap:wrap;' }, [name, upin, role, add]));

      const list = api.listUsers();
      const box = el('div', { style: 'border:1px solid #333;padding:10px;border-radius:8px;' });
      list.forEach(u => {
        const row = el('div', { style: 'display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px dashed #333;' });
        row.appendChild(el('div', { html: `<b>${u.name}</b> — ${u.role}` }));
        const del = el('button', { style: 'padding:6px 10px;cursor:pointer;' }, ['FSHI']);
        del.onclick = () => { api.manageUsers('DELETE', { id: u.id }); render(); };
        row.appendChild(del);
        box.appendChild(row);
      });
      root.appendChild(box);
    }
  }

  setTimeout(render, 50);
})();
