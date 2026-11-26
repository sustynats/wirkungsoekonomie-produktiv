const filters = document.querySelectorAll('[data-matrix-filter]');
const rows = document.querySelectorAll('[data-pair]');
const output = document.querySelector('#matrix-count');

function updateMatrix() {
  const active = Array.from(filters, filter => [filter.dataset.matrixFilter, filter.value]);
  let shown = 0;
  for (const row of rows) {
    row.hidden = !active.every(([field, value]) => !value || row.dataset[field] === value);
    if (!row.hidden) shown += 1;
  }
  output.textContent = `${shown} / ${rows.length}`;
}

const requested = new URLSearchParams(window.location.search);
for (const filter of filters) {
  const initial = requested.get(filter.dataset.matrixFilter);
  if (Array.from(filter.options).some(option => option.value === initial)) filter.value = initial;
  filter.disabled = false;
  filter.addEventListener('change', updateMatrix);
}
for (const link of document.querySelectorAll('[data-matrix-jump]')) {
  link.addEventListener('click', () => {
    for (const filter of filters) filter.value = '';
    updateMatrix();
    document.getElementById(link.hash.slice(1)).focus({preventScroll: true});
  });
}
updateMatrix();
