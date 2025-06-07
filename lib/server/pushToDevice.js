import { Meteor } from 'meteor/meteor'
import { Push } from './pushToDB'
import { sendNotification } from './notification'
import { initializeApp, cert } from 'firebase-admin/lib/app'
import { getMessaging } from 'firebase-admin/lib/messaging'

// Push.setBadge = function (/* id, count */) { /* throw new Error('Push.setBadge not implemented on the server' */ }
const isDebug = process.env.PUSH_DEBUG === 'true'
let isConfigured = false

const sendWorker = (task, interval) => {
  if (isDebug) {
    console.log('Push: Send worker started, using interval: ' + interval)
  }

  return Meteor.setInterval(() => {
    try {
      task()
    } catch (error) {
      if (isDebug) {
        console.log('Push: Error while sending:', error.message)
      }
    }
  }, interval)
}

Push.Configure = serverConfig => {
  if (isDebug) {
    console.info(
      '#####################################################################\n',
      'If Sender, the Push configurations is being applied and the sending worker starts.\n',
      'If Saver, push methods are enabled, tokens and notifications are being saved to the server. \n',
      { serverIsSender: process.env.SERVER_IS_PUSH_SENDER === 'true', serverIsSaver: process.env.SERVER_IS_PUSH_SAVER === 'true' },
      '\n#####################################################################'
    )
  }

  if (!(process.env.SERVER_IS_PUSH_SENDER === 'true')) {
    console.info(
      '#####################################################################\n',
      'You either haven\'t set the SERVER_IS_PUSH_SENDER env var, or this was set to false and consequently this server is not a Push Sender\n',
      'coming from pushToDevice.js',
      '\n#####################################################################'
    )
    return false
  }

  const self = this
  if (isConfigured) { throw new Error('Push.Configure should not be called more than once!') }
  isConfigured = true
  if (isDebug) { console.log('Push.Configure', serverConfig) }
  
  // Убедимся, что параметры конфигурации имеют корректные значения
  if (!serverConfig) serverConfig = {};
  if (!serverConfig.defaults) serverConfig.defaults = {};
  if (typeof serverConfig.defaults.sendTimeout !== 'number') serverConfig.defaults.sendTimeout = 30000;
  if (typeof serverConfig.defaults.sendInterval !== 'number') serverConfig.defaults.sendInterval = 5000;
  if (typeof serverConfig.defaults.sendBatchSize !== 'number') serverConfig.defaults.sendBatchSize = 10;

  // Rig FCM connection
  const fcm = initializeApp({
    credential: cert(serverConfig?.firebaseAdmin?.serviceAccountData),
    databaseURL: serverConfig?.firebaseAdmin?.databaseURL
  })

  const fcmConnections = getMessaging(fcm) // FCM with Firebase Admin
  if (serverConfig.firebaseAdmin) {
    if (isDebug) { console.log('Firebase Admin for Android Messaging configured') }
    if (!serverConfig.firebaseAdmin.serviceAccountData) { console.error('ERROR: Push server could not find Android serviceAccountData information') }
    if (!serverConfig.firebaseAdmin.databaseURL) { console.error('ERROR: Push server could not find databaseURL information') }
    self.requestSendNotification = (userToken, mongoNote) => sendNotification(fcmConnections, serverConfig.defaults, userToken, mongoNote)
  }

  /**
   *Constructs a query and passed it as parameter on 'querySend' function
   * mongoNote = the gross notification saved into Mongo, before serialization for the two Providers, APN and Android
   */
  self.serverSend = async (mongoNote) => {
    let query
    // set some minimum requirements for a notification to be eligible for sending.
    // TODO implement some checking for data. Perhaps not right here but once implemented remove the next 2 lines
    // console.log('in sender worker: ', mongoNote)

    if (mongoNote.userIds) {
      if (isDebug) { console.log('Push: Send message "' + mongoNote.title + '" to user(s): ', mongoNote.userIds) }
      query = {
        userId: { $in: mongoNote.userIds }
      }
    } else if (mongoNote.tokens) {
      if (isDebug) { console.log('Push: Send message "' + mongoNote.title + '" via token(s)', mongoNote.tokens) }
      // For users, I have tokens in { tokens: [Array of token objects] }. But for these users, I should send to user Ids not to tokens.
      query = {
        token: { $in: mongoNote.tokens }
      }
    } else if (mongoNote.tokenIds) {
      if (isDebug) { console.log('Push: Send message "' + mongoNote.title + '" via token Id(s)', mongoNote.tokenIds) }
      query = {
        _id: { $in: mongoNote.tokenIds }
      }
    }

    if (query) {
      /**
       * 'querySend' functions distributes the notifications to be send with the right
       * providers based on the tokens they are send to
       */
      const querySend = async (query, mongoNote) => {
        let countApn = 0
        let countAndroid = 0
        let countWeb = 0

        await Push.appCollection.find(query).forEachAsync(app => {
          if (app.tokens) {
            app.tokens.forEach(t => {
              if (isDebug) {
                if (t.vendor === 'ios') { countApn++ }
                if (t.vendor === 'android') { countAndroid++ }
                if (t.vendor === 'web') { countWeb++ }
              }
              self.requestSendNotification(t.token, mongoNote)
            })
          } else {
            if (isDebug) {
              if (app.vendor === 'ios') { countApn++ }
              if (app.vendor === 'android') { countAndroid++ }
              if (app.vendor === 'web') { countWeb++ }
            }
            self.requestSendNotification(app.token, mongoNote)
          }
        });

        if (isDebug) {
          console.log('Push: Sent message "' + mongoNote.title + '" to ' + countApn + ' ios apps | ' + countAndroid + ' android apps | ', countWeb, ' web apps')
          // Add some verbosity about the send result, making sure the developer
          // understands what just happened.
          if (!countApn && !countAndroid && !countWeb) {
            const appExists = await Push.appCollection.findOneAsync();
            if (!appExists) {
              console.log('Push, GUIDE: The "Push.appCollection" might be empty. No clients have registered on the server yet...')
            }
          }
        }

        return {
          apn: countApn,
          fcm: countAndroid,
          web: countWeb
        }
      }

      return await querySend(query, mongoNote)
    } else {
      if (isDebug) { throw new Error('Push.send: please set option either tokens, tokenIds, userIds') }
    }
  }

  let isSendingNotification = false

  if (serverConfig.defaults.sendInterval !== null) {
    const processSendNotification = async (mongoNote) => {
      // Reserve notification
      const now = Date.now()
      const timeoutAt = now + serverConfig.defaults.sendTimeout
      const reserved = await Push.notifications.updateAsync({
        _id: mongoNote._id,
        sent: false,
        sending: { $lt: now }
      }, {
        $set: {
          sending: timeoutAt
        }
      })

      // Make sure we only handle notifications reserved by this instance
      if (reserved) {
        const result = await self.serverSend(mongoNote)
        if (!serverConfig.defaults.keepNotifications) {
          await Push.notifications.removeAsync({ _id: mongoNote._id })
        } else {
          await Push.notifications.updateAsync({ _id: mongoNote._id }, {
            $set: {
              sent: true,
              sentAt: Date.now(),
              count: result,
              sending: 0
            }
          })
        }
      }
    }

    const processNotifications = async () => {
      if (isSendingNotification) return;
      
      try {
        isSendingNotification = true;
        const batchSize = serverConfig.defaults.sendBatchSize;
        const now = Date.now();
        
        try {
          await Push.notifications.find({
            $and: [
              { sent: false },
              { sending: { $lt: now } },
              {
                $or: [
                  { delayUntil: { $exists: false } },
                  { delayUntil: { $lte: now } }
                ]
              }
            ]
          }, {
            sort: { createdAt: 1 },
            limit: batchSize
          }).forEachAsync(async (mongoNote) => {
            try {
              await processSendNotification(mongoNote);
            } catch (error) {
              if (isDebug) {
                console.log('Show Full error', error);
                console.log('Push: Could not send notification id: "' + mongoNote._id + '", Error: ' + error.message);
              }
            }
          });
        } catch (error) {
          console.error('Error in notification processing:', error);
        }
      } catch (error) {
        console.error('Error in setting up notifications:', error);
      } finally {
        isSendingNotification = false;
      }
    };

    sendWorker(processNotifications, serverConfig.defaults.sendInterval);
  } else {
    if (isDebug) { console.log('Push: Send server is disabled') }
  }
}
