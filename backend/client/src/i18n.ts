//
//  i18n.ts
//  HIVE (client)
//
//  Three languages, one object each. English is the default; the toggle is
//  remembered per phone. English and German are all lower case — the site's
//  design language — except names (HIVE, Safari, iPhone…) and acronyms. The Japanese strings use the polite です/ます register
//  and the exact labels of the iOS and Chrome settings they point at (checked
//  against Apple's and Google's Japanese UI: 「モーションと画面の向きのアクセス」,
//  「サイトの設定」→「モーションセンサー」, 「詳細を表示」→「このWebサイトを閲覧」).
//

export type Lang = 'en' | 'de' | 'ja';

/** BCP 47 tag for the <html lang> attribute — the font fallback keys off it. */
export const LANG_TAG: Record<Lang, string> = { en: 'en-GB', de: 'de-AT', ja: 'ja' };

const strings = {
  en: {
    tagline: 'swarm audio. your phone becomes one voice in a swarm — its tilt and movement are turned into sound.',
    join: 'join the swarm',
    joining: 'joining…',
    leave: 'leave',
    yourName: 'name (optional)',
    streaming: 'streaming',
    connecting: 'connecting…',
    reconnecting: 'reconnecting…',
    disconnected: 'disconnected',
    transport: 'link',
    rate: 'rate',
    keepOpen: 'keep this page open and the screen on. move, tilt, turn.',
    acc: 'tilt / gravity — accelerometer, m/s²',
    gyro: 'turning speed — gyroscope, °/s',
    sent: 'sent',
    dropped: 'dropped',
    invert: 'flip an axis if it feels wrong',
    waiting: 'you are in. the swarm starts in a moment — hold on.',
    queenNone: 'no queen yet — move a lot! whoever moves most becomes the first queen.',
    queenHidden: 'the queen is hidden — nobody knows who she is, not even her. listen, and find her.',
    queenHint: 'collide with the queen to become queen.',
    queenYou: 'you are the queen and very important — nobody should touch you.',
    errInsecure: 'this page was opened over plain HTTP. phones only share motion sensors over HTTPS — scan the QR code again and make sure the address starts with https://.',
    errUnsupported: 'this browser does not expose motion sensors (no DeviceMotionEvent). try Safari on iPhone or Chrome on Android.',
    errDenied: 'motion access was denied. on iPhone: reload the page and tap allow — or check settings → Safari → motion & orientation access. on Android: check the site permissions in Chrome.',
    errNoData: 'no sensor data is arriving. is this a laptop? motion sensors are only in phones and tablets.',
    errServer: 'cannot reach the server. are you on the same wi-fi as the computer running HIVE?',
    retry: 'try again',
    credit: 'HIVE · music & AI hackathon 2026',
  },
  de: {
    tagline: 'swarm audio. dein handy wird eine stimme im schwarm — neigung und bewegung werden zu klang.',
    join: 'dem schwarm beitreten',
    joining: 'beitreten…',
    leave: 'verlassen',
    yourName: 'name (optional)',
    streaming: 'sendet',
    connecting: 'verbinde…',
    reconnecting: 'verbinde neu…',
    disconnected: 'getrennt',
    transport: 'verbindung',
    rate: 'rate',
    keepOpen: 'lass die seite offen und den bildschirm an. beweg dich, neige, dreh.',
    acc: 'neigung / schwerkraft — accelerometer, m/s²',
    gyro: 'drehgeschwindigkeit — gyroskop, °/s',
    sent: 'gesendet',
    dropped: 'verworfen',
    invert: 'achse umkehren, falls es sich falsch anfühlt',
    waiting: 'du bist drin. der schwarm startet gleich — noch kurz warten.',
    queenNone: 'noch keine königin — beweg dich viel! wer sich am meisten bewegt, wird die erste königin.',
    queenHidden: 'die königin ist versteckt — niemand weiß, wer sie ist, nicht einmal sie selbst. hört hin und findet sie.',
    queenHint: 'flieg in die königin, um selbst königin zu werden.',
    queenYou: 'du bist die königin und sehr wichtig — niemand darf dich berühren.',
    errInsecure: 'diese seite wurde über HTTP geöffnet. handys geben bewegungssensoren nur über HTTPS frei — scanne den QR-code erneut und achte darauf, dass die adresse mit https:// beginnt.',
    errUnsupported: 'dieser browser bietet keine bewegungssensoren (kein DeviceMotionEvent). versuch Safari am iPhone oder Chrome unter Android.',
    errDenied: 'zugriff auf bewegungsdaten wurde verweigert. iPhone: seite neu laden und „erlauben" tippen — oder einstellungen → Safari → „bewegung & ausrichtung" prüfen. Android: website-berechtigungen in Chrome prüfen.',
    errNoData: 'es kommen keine sensordaten. ist das ein laptop? bewegungssensoren gibt es nur in handys und tablets.',
    errServer: 'server nicht erreichbar. bist du im selben WLAN wie der Computer, auf dem HIVE läuft?',
    retry: 'nochmal versuchen',
    credit: 'HIVE · music & AI hackathon 2026',
  },
  ja: {
    tagline: 'スウォーム・オーディオ。あなたのスマートフォンが、群れの中のひとつの声になります。傾きと動きが音に変わります。',
    join: '群れに参加する',
    joining: '参加しています…',
    leave: '退出する',
    yourName: 'お名前（任意）',
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
    waiting: '参加できました。まもなく始まります。少々お待ちください。',
    queenNone: 'まだ女王蜂はいません。たくさん動いてください！いちばん動いた人が最初の女王蜂になります。',
    queenHidden: '女王蜂は隠れています。誰が女王蜂なのか、本人も知りません。耳を澄まして、探してください。',
    queenHint: '女王蜂にぶつかると、あなたが女王蜂になります。',
    queenYou: 'あなたは女王蜂です。とても大切な存在ですので、誰も触れてはいけません。',
    errInsecure: 'このページはHTTPで開かれています。スマートフォンのモーションセンサーはHTTPS経由でのみ利用できます。QRコードをもう一度読み取り、アドレスが https:// で始まっていることをご確認ください。',
    errUnsupported: 'このブラウザではモーションセンサーを利用できません（DeviceMotionEvent非対応）。iPhoneではSafari、AndroidではChromeをお試しください。',
    errDenied: 'モーションセンサーへのアクセスが許可されませんでした。iPhoneの場合：ページを再読み込みして「許可」をタップするか、「設定」→「Safari」→「モーションと画面の向きのアクセス」をご確認ください。Androidの場合：Chromeの「サイトの設定」→「モーションセンサー」をご確認ください。',
    errNoData: 'センサーデータが届いていません。パソコンでご覧になっていませんか？モーションセンサーはスマートフォンとタブレットにのみ搭載されています。',
    errServer: 'サーバーに接続できません。HIVEを実行しているコンピューターと同じWi-Fiに接続していますか？',
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
