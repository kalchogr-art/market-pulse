# Market Pulse V1.0.0

Първа версия: защитена диагностика на Capital.com DEMO и търсене на котировки.
Няма сигнали, стратегия, поръчки, Cron или D1 записване. Няма live API адрес.

## Файлове в GitHub

- `src/index.ts` — кодът на Worker-а.
- `wrangler.jsonc` — в основната директория.
- `package.json` — в основната директория.
- `.gitignore` — не допуска локални Secrets в Git.

Качи съдържанието на папката market-pulse в корена на репото, не допълнителна вложена папка.
В Cloudflare: Workers & Pages → market-pulse → Settings → Builds → Connect.
Repository: market-pulse; branch: main; root: /; build command: празно;
deploy command: npx wrangler deploy.
Името на съществуващия Worker трябва да е market-pulse.
При локална работа: npm install, npm run check, npm run dev.
След npm install може да commit-неш package-lock.json за фиксирани зависимости.

## Secrets — в настройките на Worker-а, НЕ в Build variables

Cloudflare → market-pulse → Settings → Variables and Secrets → Add → Secret.

| Име | Стойност |
|---|---|
| CAPITAL_API_KEY | Генерираният Capital.com API ключ |
| CAPITAL_IDENTIFIER | Имейлът/идентификаторът за вход в Capital.com |
| CAPITAL_API_PASSWORD | Отделната парола, зададена при създаването на API ключа |
| ADMIN_TOKEN | Твой нов случаен токен, минимум 32 знака, различен от Capital.com данните |

ADMIN_TOKEN може да се генерира от password manager или чрез `openssl rand -hex 32`.
Не поставяй никакви ключове или пароли в GitHub, URL адреси или снимки.

## Първи тест

1. Запази Secrets и приложи deployment-а, ако Cloudflare го поиска.
2. Отвори HTTPS workers.dev адреса. Страницата е публична, диагностиката е защитена.
3. Въведи ADMIN_TOKEN (не API ключа) и натисни „Провери връзката и акаунтите“.
4. Очакван резултат: success: true, mode: DEMO_READ_ONLY, trading_enabled: false.
5. Потърси EURUSD, GBPUSD, gold, silver и oil поотделно.
   Избираме окончателните инструменти и epic кодове след проверка на резултатите.

/health проверява само Worker-а, НЕ връзката с брокера.
/api/check и /api/markets?q=gold изискват Authorization: Bearer <ADMIN_TOKEN>.
Токенът в страницата се пази само в текущото поле, без localStorage/cookie.
Балансите са виртуални от demo API. account IDs и broker session tokens не се показват.
POST /session се използва единствено за вход; всички останали broker заявки са GET.

## Диагностика

- MISSING_SECRETS: липсват изброените Secrets.
- ADMIN_TOKEN_MISSING_OR_TOO_SHORT: добави токен с поне 32 знака.
- UNAUTHORIZED: токенът в страницата не съвпада с ADMIN_TOKEN.
- CAPITAL_AUTH_REJECTED: провери API ключа, отделната му парола, имейла и demo достъпа.
  При изтекла сесия повтори проверката; 401 изчиства кеша.
- CAPITAL_RATE_LIMIT / LOGIN_COOLDOWN_RETRY: изчакай преди нова проверка.
- CAPITAL_NETWORK_OR_TIMEOUT: upstream връзката не е завършила за 12 секунди.
- CAPITAL_NON_JSON_RESPONSE: API/мрежов посредник е върнал неочакван отговор.
- Празен markets списък: пробвай друго име; не е автоматично проблем с връзката.

Сесията е кеширана само в паметта на един Worker isolate за 8 минути.
Първата версия е за ръчни диагностични проверки, не за интензивно polling.
Котировките не се обновяват автоматично. API timestamp/status трябва да се проверят
преди бъдещо използване за сигнали. Спредът е offer - bid в ценови единици, не в пипсове.
Този пакет не е качен в GitHub или Cloudflare от асистента.

Документация: https://open-api.capital.com/
