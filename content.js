(async () => {
const { privacyConsent } = await chrome.storage.local.get({ privacyConsent: null });
if (privacyConsent?.version !== 1) return;

const button = document.createElement('button');
button.id = 'at-cycle-catalog-add';
button.textContent = 'Добавить цикл';
Object.assign(button.style, { position: 'fixed', right: '18px', bottom: '18px', zIndex: 99999, padding: '10px 14px', border: 0, borderRadius: '8px', background: '#6553c9', color: 'white', fontWeight: '700', cursor: 'pointer', boxShadow: '0 3px 14px #0006' });
button.onclick = async () => {
  try {
    button.disabled = true;
    button.textContent = 'Добавляю…';
    const result = await chrome.runtime.sendMessage({ type: 'addCurrentCycle', url: location.href });
    button.textContent = result.added ? 'Добавлено в каталог' : 'Уже в каталоге';
  } catch {
    button.disabled = false;
    button.textContent = 'Обновите страницу и повторите';
  }
};
document.getElementById(button.id)?.remove();
document.body.append(button);
})();
