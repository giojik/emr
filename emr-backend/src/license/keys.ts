/**
 * ლიცენზიის საჯარო გასაღებები (Ed25519, SPKI DER, base64) — build-ის ნაწილი.
 * პირადი გასაღები — მხოლოდ გამცემთან (repo-ში არასდროს). ახალი გასაღები:
 *   npm run license -- keygen --kid 2026-1 --out ~/emr-license/2026-1.key
 * ბრძანება დაბეჭდავს ხაზს, რომელიც აქ, PROD_KEYS-ში ემატება (kid → საჯარო გასაღები). ძველი kid არ იშლება,
 * სანამ მისი ხელმოწერილი ლიცენზიები მოქმედებს (როტაცია).
 */
export const PROD_KEYS: Record<string, string> = {
};

/**
 * სატესტო გასაღები (e2e): მიიღება მხოლოდ NODE_ENV ≠ production და LICENSE_TEST_KEY=1.
 * პირადი ნაწილი — scripts/test-license/TEST_ONLY_private.pem (საჯაროდ ცნობილია; production-ში უძლურია).
 */
export const TEST_KEYS: Record<string, string> = {
  'test-0085': 'MCowBQYDK2VwAyEAaqmBmgl0NSBZA8OI4us7NgPUGNqqSIT6/6SlvYc21iM=',
};
