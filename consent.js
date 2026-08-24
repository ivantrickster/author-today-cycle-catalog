(function () {
  const CONSENT_VERSION = 1;

  window.requirePrivacyConsent = async function requirePrivacyConsent() {
    const state = await chrome.storage.local.get({ privacyConsent: null });
    if (state.privacyConsent?.version === CONSENT_VERSION) return true;

    return new Promise(resolve => {
      document.documentElement.classList.add('privacy-consent-pending');
      const overlay = document.createElement('div');
      overlay.className = 'privacy-consent-overlay';
      document.body.append(overlay);
      overlay.innerHTML = `<section class="privacy-consent-card" role="dialog" aria-modal="true" aria-labelledby="privacyConsentTitle">
        <div class="privacy-consent-content">
          <p class="privacy-consent-eyebrow">Перед началом работы</p>
          <h1 id="privacyConsentTitle">Как расширение использует данные</h1>
          <p>Расширение обрабатывает адрес открытой страницы Author.Today, открытые сведения о циклах и ваши действия внутри каталога. Это необходимо для поиска, сохранения циклов и расчёта статистики.</p>
          <p>Данные и настройки хранятся локально в браузере. Разработчик их не получает; рекламы и внешней аналитики нет.</p>
          <a href="privacy.html" target="_blank" rel="noopener">Условия использования и политика конфиденциальности</a>
        </div>
        <div class="privacy-consent-actions">
          <button class="privacy-consent-decline" type="button">Отклонить</button>
          <button class="privacy-consent-accept" type="button">Принять</button>
        </div>
      </section>`;
      overlay.querySelector('.privacy-consent-accept').focus();
      overlay.querySelector('.privacy-consent-accept').onclick = async () => {
        await chrome.storage.local.set({ privacyConsent: { version: CONSENT_VERSION, acceptedAt: new Date().toISOString() } });
        overlay.remove();
        document.documentElement.classList.remove('privacy-consent-pending');
        resolve(true);
      };
      overlay.querySelector('.privacy-consent-decline').onclick = () => {
        overlay.innerHTML = `<section class="privacy-consent-card privacy-consent-declined" role="dialog" aria-modal="true" aria-labelledby="privacyConsentDeclinedTitle">
          <div class="privacy-consent-content">
            <p class="privacy-consent-eyebrow">Данные не обрабатываются</p>
            <h1 id="privacyConsentDeclinedTitle">Расширение не запущено</h1>
            <p>Без согласия расширение не открывает страницы Author.Today, не собирает статистику и не сохраняет циклы.</p>
          </div>
          <div class="privacy-consent-actions">
            <button class="privacy-consent-review" type="button">Вернуться к выбору</button>
          </div>
        </section>`;
        overlay.querySelector('.privacy-consent-review').onclick = () => location.reload();
        overlay.querySelector('.privacy-consent-review').focus();
        resolve(false);
      };
    });
  };
})();
