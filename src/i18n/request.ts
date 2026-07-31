import { getRequestConfig } from 'next-intl/server';

export default getRequestConfig(async () => {
  // IMCRM's primary market is Brazil. Deployments can still override
  // the locale explicitly without inheriting the host machine locale.
  const locale = process.env.NEXT_PUBLIC_APP_LOCALE || 'pt-BR';

  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch {
    // Keep the product usable if an unsupported locale is configured.
    messages = (await import(`../../messages/pt-BR.json`)).default;
  }

  return {
    locale,
    messages
  };
});
