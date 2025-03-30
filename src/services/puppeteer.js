const puppeteer = require('puppeteer-core');
const { CHROME_PATH, getUserCredentials } = require('../config/env');

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

  // 로그인 페이지로 직접 이동
  await page.goto('https://owner.kimcaddie.com/login', { waitUntil: 'networkidle2', timeout: 60000 });
  console.log('[INFO] Browser launched and navigated to KimCaddie login page');
  
  // 자동 로그인 시도
  await tryAutoLogin(page);
  
  return { browser, page };
};

// 자동 로그인 시도
const tryAutoLogin = async (page) => {
  const { phone, password, hasCredentials } = getUserCredentials();
  
  if (!hasCredentials) {
    console.log('[INFO] No saved credentials found. Waiting for manual login.');
    return false;
  }
  
  try {
    console.log('[INFO] Attempting auto-login...');
    
    // 페이지가 완전히 로드될 때까지 대기
    await page.waitForSelector('#phoneNumber', { timeout: 10000 });
    
    // 핸드폰 번호 입력
    await page.type('#phoneNumber', phone);
    console.log('[INFO] Entered phone number');
    
    // 비밀번호 입력
    await page.type('#password', password);
    console.log('[INFO] Entered password');
    
    // 로그인 버튼 클릭
    const loginButton = await page.$('button[type="submit"]');
    await loginButton.click();
    console.log('[INFO] Clicked login button');
    
    // 로그인 성공/실패 확인
    try {
      // 대시보드 페이지가 로드되면 로그인 성공으로 간주
      await page.waitForNavigation({ timeout: 10000 });
      
      // 추가로 로그인 후 특정 요소가 있는지 확인
      const isLoggedIn = await page.evaluate(() => {
        // 로그인 후 페이지에 나타나는 특정 요소를 확인 (이 부분은 실제 페이지 구조에 맞게 수정 필요)
        return document.querySelector('.MuiDrawer-root') != null;
      });
      
      if (isLoggedIn) {
        console.log('[INFO] Auto-login successful!');
        return true;
      } else {
        console.log('[WARN] Navigation completed but login verification failed');
        return false;
      }
    } catch (e) {
      console.log('[WARN] Auto-login may have failed: ' + e.message);
      
      // 로그인 오류 메시지가 있는지 확인
      const errorMessage = await page.evaluate(() => {
        // 에러 메시지를 표시하는 요소 찾기 (실제 페이지 구조에 맞게 수정 필요)
        const errorEl = document.querySelector('.error-message') || document.querySelector('.MuiAlert-message');
        return errorEl ? errorEl.textContent : '';
      });
      
      if (errorMessage) {
        console.log(`[ERROR] Login failed: ${errorMessage}`);
      }
      
      return false;
    }
  } catch (error) {
    console.error(`[ERROR] Auto-login error: ${error.message}`);
    return false;
  }
};

module.exports = { launchBrowser };
