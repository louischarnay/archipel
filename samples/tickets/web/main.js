const list = document.querySelector('#list');
const select = document.querySelector('[name=customer]');

async function loadCustomers() {
  const customers = await archipel.api('/data/shared.customer');
  select.replaceChildren(new Option('No customer', ''), ...customers.map((c) => new Option(c.name, c.id)));
}

async function refresh() {
  const tickets = await archipel.api('/data/ticket');
  list.replaceChildren(...tickets.map((ticket) => {
    const item = document.createElement('li');
    const title = document.createElement('span');
    title.textContent = ticket.title;
    title.className = ticket.status;
    item.append(title);
    if (ticket.status === 'open') {
      const close = document.createElement('button');
      close.textContent = 'Close';
      close.onclick = async () => {
        await archipel.api(`/tickets/${ticket.id}/close`, { method: 'POST' });
        refresh();
      };
      item.append(close);
    }
    return item;
  }));
}

document.querySelector('#add').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  await archipel.api('/data/ticket', {
    method: 'POST',
    body: { title: form.get('title'), customer_id: form.get('customer') || null },
  });
  event.target.reset();
  refresh();
});

loadCustomers();
refresh();
