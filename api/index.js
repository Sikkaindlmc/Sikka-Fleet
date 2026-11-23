const app = require('../backend/server');

const FORWARDED_PATH_PARAM = '__sikka_path';

module.exports = (req, res) => {
  const requestUrl = new URL(req.url, 'http://vercel.local');
  const forwardedPath = requestUrl.searchParams.get(FORWARDED_PATH_PARAM);

  if (forwardedPath !== null) {
    if (
      !['/', '/api', '/uploads', '/share'].some(prefix =>
        forwardedPath === prefix || forwardedPath.startsWith(`${prefix}/`)
      ) ||
      forwardedPath.includes('?') ||
      forwardedPath.includes('#')
    ) {
      return res.status(400).json({ error: 'Invalid forwarded path' });
    }

    requestUrl.searchParams.delete(FORWARDED_PATH_PARAM);
    req.url = `${forwardedPath}${requestUrl.search}`;
  }

  return app(req, res);
};
