//
//  i18n.ts
//  HIVE (client)
//
//  Three languages, one object each. English is the default; the toggle is
//  remembered per phone. The Japanese strings use the polite です/ます register
//  and the exact labels of the iOS and Chrome settings they point at (checked
//  against Apple's and Google's Japanese UI: 「モーションと画面の向きのアクセス」,
//  「サイトの設定」→「モーションセンサー」, 「詳細を表示」→「このWebサイトを閲覧」).
//

export type Lang = 'en' | 'de' | 'ja';

/** BCP 47 tag for the <html lang> attribute — the font fallback keys off it. */
export const LANG_TAG: Record<Lang, string> = { en: 'en-GB', de: 'de-AT', ja: 'ja' };

const strings = {
  en: {
    tagline: 'Swarm audio. Your phone becomes one voice in a swarm — its tilt and movement are turned into sound.',
    join: 'Join the swarm',
    joining: 'Joining…',
    leave: 'Leave',
    yourName: 'Name (optional)',
    youAre: 'you are',
    streaming: 'streaming',
    connecting: 'connecting…',
    reconnecting: 'reconnecting…',
    disconnected: 'disconnected',
    transport: 'link',
    rate: 'rate',
    keepOpen: 'Keep this page open and the screen on. Move, tilt, turn.',
    acc: 'tilt / gravity — accelerometer, m/s²',
    gyro: 'turning speed — gyroscope, °/s',
    sent: 'sent',
    dropped: 'dropped',
    invert: 'flip an axis if it feels wrong',
    errInsecure: 'This page was opened over plain HTTP. Phones only share motion sensors over HTTPS — scan the QR code again and make sure the address starts with https://.',
    errUnsupported: 'This browser does not expose motion sensors (no DeviceMotionEvent). Try Safari on iPhone or Chrome on Android.',
    errDenied: 'Motion access was denied. On iPhone: reload the page and tap Allow — or check Settings → Safari → Motion & Orientation Access. On Android: check the site permissions in Chrome.',
    errNoData: 'No sensor data is arriving. Is this a laptop? Motion sensors are only in phones and tablets.',
    errServer: 'Cannot reach the server. Are you on the same Wi-Fi as the Mac running HIVE?',
    retry: 'Try again',
    credit: 'HIVE · Music & AI Hackathon 2026',
  },
  de: {
    tagline: 'Swarm Audio. Dein Handy wird eine Stimme im Schwarm — Neigung und Bewegung werden zu Klang.',
    join: 'Dem Schwarm beitreten',
    joining: 'Beitreten…',
    leave: 'Verlassen',
    yourName: 'Name (optional)',
    youAre: 'du bist',
    streaming: 'sendet',
    connecting: 'verbinde…',
    reconnecting: 'verbinde neu…',
    disconnected: 'getrennt',
    transport: 'Verbindung',
    rate: 'Rate',
    keepOpen: 'Lass die Seite offen und den Bildschirm an. Beweg dich, neige, dreh.',
    acc: 'Neigung / Schwerkraft — Accelerometer, m/s²',
    gyro: 'Drehgeschwindigkeit — Gyroskop, °/s',
    sent: 'gesendet',
    dropped: 'verworfen',
    invert: 'Achse umkehren, falls es sich falsch anfühlt',
    errInsecure: 'Diese Seite wurde über HTTP geöffnet. Handys geben Bewegungssensoren nur über HTTPS frei — scanne den QR-Code erneut und achte darauf, dass die Adresse mit https:// beginnt.',
    errUnsupported: 'Dieser Browser bietet keine Bewegungssensoren (kein DeviceMotionEvent). Versuch Safari am iPhone oder Chrome unter Android.',
    errDenied: 'Zugriff auf Bewegungsdaten wurde verweigert. iPhone: Seite neu laden und „Erlauben" tippen — oder Einstellungen → Safari → „Bewegung & Ausrichtung" prüfen. Android: Website-Berechtigungen in Chrome prüfen.',
    errNoData: 'Es kommen keine Sensordaten. Ist das ein Laptop? Bewegungssensoren gibt es nur in Handys und Tablets.',
    errServer: 'Server nicht erreichbar. Bist du im selben WLAN wie der Mac, auf dem HIVE läuft?',
    retry: 'Nochmal versuchen',
    credit: 'HIVE · Music & AI Hackathon 2026',
  },
  ja: {
    tagline: 'スウォーム・オーディオ。あなたのスマートフォンが、群れの中のひとつの声になります。傾きと動きが音に変わります。',
    join: '群れに参加する',
    joining: '参加しています…',
    leave: '退出する',
    yourName: 'お名前（任意）',
    youAre: 'あなたは',
    streaming: '送信中',
    connecting: '接続しています…',
    reconnecting: '再接続しています…',
    disconnected: '切断されました',
    transport: '接続',
    rate: 'レート',
    keepOpen: 'このページを開いたまま、画面をオンにしておいてください。動いたり、傾けたり、回したりしてみてください。',
    acc: '傾き／重力 — 加速度センサー、m/s²',
    gyro: '回転速度 — ジャイロセンサー、°/s',
    sent: '送信',
    dropped: '破棄',
    invert: '向きが逆に感じられる場合は、軸を反転してください',
    errInsecure: 'このページはHTTPで開かれています。スマートフォンのモーションセンサーはHTTPS経由でのみ利用できます。QRコードをもう一度読み取り、アドレスが https:// で始まっていることをご確認ください。',
    errUnsupported: 'このブラウザではモーションセンサーを利用できません（DeviceMotionEvent非対応）。iPhoneではSafari、AndroidではChromeをお試しください。',
    errDenied: 'モーションセンサーへのアクセスが許可されませんでした。iPhoneの場合：ページを再読み込みして「許可」をタップするか、「設定」→「Safari」→「モーションと画面の向きのアクセス」をご確認ください。Androidの場合：Chromeの「サイトの設定」→「モーションセンサー」をご確認ください。',
    errNoData: 'センサーデータが届いていません。パソコンでご覧になっていませんか？モーションセンサーはスマートフォンとタブレットにのみ搭載されています。',
    errServer: 'サーバーに接続できません。HIVEを実行しているMacと同じWi-Fiに接続していますか？',
    retry: 'もう一度試す',
    credit: 'HIVE · Music & AI Hackathon 2026',
  },
} as const;

export type Key = keyof typeof strings.en;

const stored = localStorage.getItem('hive.lang');
let current: Lang = stored === 'de' || stored === 'ja' ? stored : 'en';

export const lang = (): Lang => current;
export const t = (key: Key): string => strings[current][key];
export function setLang(l: Lang): void {
  current = l;
  localStorage.setItem('hive.lang', l);
  document.documentElement.lang = LANG_TAG[l];
}
