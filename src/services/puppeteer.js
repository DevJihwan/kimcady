const puppeteer = require('puppeteer-core');
const { CHROME_PATH } = require('../config/env');

const launchBrowser = async () => {
  const { width, height } = require('electron').screen.getPrimaryDisplay().workAreaSize;

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--start-maximized',
      `--window-size=${width},${height}`,
      '--window-position=0,0',
      '--disable-notifications',
      '--disable-infobars',
    ],
    defaultViewport: null,
  });

  const page = (await browser.pages())[0] || await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });

  try {
    await page._client.send('Browser.setWindowBounds', { windowId: 1, bounds: { windowState: 'maximized' } });
  } catch (e) {
    console.log('[DEBUG] First maximize failed, using fallback');
    await page.evaluate(() => window.resizeTo(screen.availWidth, screen.availHeight));
  }

  await page.goto('https://owner.kimcaddie.com/', { waitUntil: 'networkidle2', timeout: 60000 });
  console.log('[INFO] Browser launched and navigated to KimCaddie');
  return { browser, page };
};

module.exports = { launchBrowser };