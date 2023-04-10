/* globals Package, Npm, Cordova */
Package.describe({
  name: 'activitree:push',
  version: '3.0.0',
  summary: 'Push Notifications for Cordova and Web/PWA with Firebase (FCM).',
  git: 'https://github.com/activitree/meteor-push.git'
});

Npm.depends({
  'firebase-admin': '11.6.0', // 11.5.0
  firebase: '9.19.1', // 9.18.0
  events: '3.3.0',
  once: '1.4.0'
});

Cordova.depends({
  'cordova-plugin-push': 'https://github.com/havesource/cordova-plugin-push.git#a9939fa5ba027c9bb75e3675b4bc0a617a4840db', // 3.0.1
  'cordova-plugin-device': '2.1.0'
});

Package.onUse(api => {
  api.versionsFrom('2.11.0')
  api.use(['tracker'], ['web.browser', 'web.cordova'])
  api.use(['accounts-base'], ['web.browser', 'web.cordova', 'server'], { weak: true })
  api.use([
    'ecmascript',
    'check',
    'mongo',
    'ejson',
    'random'
  ], ['client', 'server']);

  // API's
  api.addFiles('lib/server/pushToDevice.js', 'server');
  api.addFiles('lib/server/internalMethods.js', 'server');

  api.mainModule('lib/client/cordova.js', ['web.cordova']);
  // api.mainModule('lib/client/web.js', ['web.browser']);
  api.mainModule('lib/server/pushToDB.js', ['server']);
});
