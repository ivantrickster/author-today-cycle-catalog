(function () {
  const CONSENT_VERSION = 1;

  window.requirePrivacyConsent = async function requirePrivacyConsent() {
    const state = await chrome.storage.local.get({ privacyConsent: null });
    if (state.privacyConsent?.version === CONSENT_VERSION) return true;

    return new Promise(resolve => {
      document.documentElement.classList.add('privacy-consent-pending');
      const overlay = document.createElement('div');
      overlay.className = 'privacy-consent-overlay';
      overlay.innerHTML = `<section class="privacy-consent-card" role="dialog" aria-modal="true" aria-labelledby="privacyConsentTitle">
        <p class="privacy-consent-eyebrow">Перед началом работы</p>
        <h1 id="privacyConsentTitle">Как расширение использует данные</h1>
        <p>Расширение обрабатывает адрес открытой страницы Author.Today, открытые сведения о циклах и ваши действия внутри каталога. Это необходимо для поиска, сохранения циклов и расчёта статистики.</p>
        <p>Данные и настройки хранятся локально в браузере. Разработчик их не получает; рекламы и внешней аналитики нет.</p>
        <a href="privacy.html" target="_blank" rel="noopener">Условия использования и политика конфиденциальности</a>
        <button type="button">Понятно, продолжить</button>
      </section>`;
      document.body.append(overlay);
      overlay.querySelector('button').focus();
      overlay.querySelector('button').onclick = async () => {
        await chrome.storage.local.set({ privacyConsent: { version: CONSENT_VERSION, acceptedAt: new Date().toISOString() } });
        overlay.remove();
        document.documentElement.classList.remove('privacy-consent-pending');
        resolve(true);
      };
    });
  };
})();
