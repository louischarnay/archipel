const list = document.querySelector('#list');

async function refresh() {
  const rows = await archipel.api('/data/shared.customer');
  list.replaceChildren(...rows.map((row) => {
    const item = document.createElement('li');
    item.textContent = row.email ? `${row.name} — ${row.email}` : row.name;
    return item;
  }));
}

document.querySelector('#add').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  await archipel.api('/data/shared.customer', {
    method: 'POST',
    body: { name: form.get('name'), email: form.get('email') || null },
  });
  event.target.reset();
  refresh();
});

refresh();
