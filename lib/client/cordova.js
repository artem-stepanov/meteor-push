/* globals device, PushNotification: false, EJSON */

// FCM Token recommendations: https://firebase.google.com/docs/cloud-messaging/manage-tokens

import { Meteor } from 'meteor/meteor'
import { Tracker } from 'meteor/tracker'
import EventEmitter from 'events'
import once from 'once'


const deviceStorage = window.localStorage

export const PushEventState = new EventEmitter()
function EventState () {}

const storedToken = deviceStorage.getItem('Push.token')

let platform = {}
Meteor.startup(() => {
  platform = device.platform?.toLowerCase()
  console.log({ storedToken }, PushNotification)
  
  // Проверяем актуальность сохраненного токена в базе данных
  if (storedToken) {
    validateStoredToken()
  }
  
  // Отслеживаем изменения статуса авторизации пользователя
  Tracker.autorun(() => {
    const userId = Meteor.userId()
    const attachedUserId = deviceStorage.getItem('Push.attachedToUser')
    const currentStoredToken = deviceStorage.getItem('Push.token')
    
    // Если пользователь вошел в систему и у нас есть токен, но он не привязан к текущему пользователю
    if (userId && currentStoredToken && attachedUserId !== userId) {
      console.log('User logged in, checking token status for new user')
      validateStoredToken()
    }
  })
})

// Функция для проверки актуальности токена в базе данных
async function validateStoredToken() {
  try {
    const tokenId = deviceStorage.getItem('Push.tokenId')
    if (!tokenId) {
      console.log('Push.tokenId not found, skipping validation')
      return
    }

    // Проверяем существует ли токен в базе данных
    const tokenExists = await Meteor.callAsync('token-validate', { 
      _id: tokenId, 
      token: storedToken 
    })
    
    if (!tokenExists) {
      console.log('Token not found in database, checking if user is logged in')
      
      // Если пользователь авторизован, добавляем токен в базу
      if (Meteor.userId()) {
        console.log('User is logged in, re-adding token to database')
        
        const tokenData = {
          token: { 
            vendor: platform, 
            token: storedToken 
          },
          appName: deviceStorage.getItem('Push.appName') || 'Unknown'
        }
        
        const newTokenId = await Meteor.callAsync('token-insert', tokenData)
        deviceStorage.setItem('Push.tokenId', newTokenId)
        deviceStorage.setItem('Push.enabled', 'true')
        deviceStorage.setItem('Push.updatedAt', Date.now().toString())
        deviceStorage.setItem('Push.attachedToUser', Meteor.userId())
        
        console.log('Token successfully re-added to database with id:', newTokenId)
      } else {
        console.log('User not logged in, keeping token locally until login')
        // Оставляем токен локально, он будет добавлен в БД при входе пользователя
      }
    } else {
      console.log('Token validated successfully in database')
      deviceStorage.setItem('Push.enabled', 'true')
    }
  } catch (error) {
    console.error('Error validating stored token:', error)
    // В случае ошибки не удаляем токен, возможно проблема с сетью
  }
}

class PushHandle extends EventState {

  constructor () {
    super()
    this.configured = false
  }

  setBadge (count, platform) {
    if (this.push) {
      once('ready', () => {
        this.log('PushHandle.setBadge:', count)
        this.push.setApplicationIconBadgeNumber(() => {
          this.log('PushHandle.setBadge: was set to', count)
        }, (e) => {
          PushEventState.emit('error', {
            type: platform + '.cordova',
            error: 'PushHandle.setBadge Error: ' + e.message
          })
        }, count)
      })
    } else {
      console.log('PushHandle.unregister, Error: "Push not configured"')
    }
  }

  getBadge () {
    if (this.push) {
      this.push.getApplicationIconBadgeNumber(
        n => {
          console.log('success reading badge number', n)
        },
        () => {
          console.log('error')
        }
      )
    } else {
      console.log('PushHandle.unregister, Error: "Push not configured"')
    }
  }

  unregister () {
    if (this.push) {
      this.push.unregister(
        () => {
          Meteor.callAsync('token-remove', { _id: deviceStorage.getItem('Push.tokenId'), token: { vendor: platform, token: deviceStorage.getItem('Push.token') } })
            .then(res => {
              this.log('Found tokens and deleted: ', res)
              deviceStorage.removeItem('Push.token')
              deviceStorage.removeItem('Push.attachedToUser')
              deviceStorage.removeItem('Push.tokenId')
              deviceStorage.setItem('Push.updatedAt', Date.now().toString())
            })
            .catch(err => this.log('Could not delete this token from DB: ', err))
        },
        () => console.log('error when unregistering')
      )
    } else {
      console.log('PushHandle.unregister, Error: "Push not configured"')
    }
  }

  listChannels () {
    if (this.push) {
      this.push.listChannels(channels => {
        for (const channel of channels) {
          console.log(`ID: ${channel.id} Description: ${channel.description}`)
        }
      })
    } else {
      console.log('PushHandle.unregister, Error: "Push not configured"')
    }
  }

  Configure (configuration = {}) {
    // if (!this.configured) {
    this.log = function (...a) {
        if (configuration.debug) {
          console.log(...a)
        }
      }
    this.log('PushHandle.Configure:', configuration)
    
    // Сохраняем appName для использования при валидации токена
    if (configuration.appName) {
      deviceStorage.setItem('Push.appName', configuration.appName)
    }
    
    this.configured = !!deviceStorage.getItem('Push.token')

    const hardware = {
      // could get more data here, perhaps phone model, os version for internal analytics.
      platform
    }

    /**
     * Start the necessary Push Listeners
     */
    if (PushNotification) {
      this.push = PushNotification.init(configuration)

      this.push.on('registration', data => {
        console.log('PushHandle.registration')

        const storedToken = deviceStorage.getItem('Push.token')
        if (data?.registrationId && (!storedToken || storedToken !== data.registrationId)) {
          const token = { vendor: hardware.platform, token: data.registrationId }
          this.log('PushHandle.Token vendor:', token.vendor)
          this.log('PushHandle.Token token:', token.token)
          deviceStorage.setItem('Push.token', data.registrationId)
          deviceStorage.setItem('Push.updatedAt', Date.now().toString())
          deviceStorage.setItem('Push.attachedToUser', Meteor.userId())

          const tokenData = {
            token,
            appName: configuration.appName
          }

          this.incrementEverySecond = setInterval(() => {
            console.log('PushHandle.incrementEverySecond: checking for permission')
            PushNotification.hasPermission(data => {
              console.log('PushHandle.incrementEverySecond: hasPermission')
              if (data.isEnabled || platform === 'android') {
                console.log('PushHandle.incrementEverySecond')
                Meteor.callAsync('token-insert', tokenData)
                  .then(res => {
                    this.log('Let\'s see the result of update', res)
                    deviceStorage.setItem('Push.tokenId', res) // _id of the document in Mongo
                    deviceStorage.setItem('Push.enabled', 'true')
                    clearTimeout(this.unregisterWhenNoAction)
                  })
                  .catch(err => this.log('Could not save this token to DB: ', err))
              }
            })
            if (deviceStorage.getItem('Push.enabled') === 'true' && Meteor.userId()) {
              console.log('PushHandle.incrementEverySecond.clearInterval')
              clearInterval(this.incrementEverySecond)
            }
          }, 1000)
          this.unregisterWhenNoAction = setTimeout(() => {
            this.push.unregister(
              () => {
                Meteor.callAsync('token-remove', tokenData)
                  .then(res => {
                    this.log('Found tokens and deleted: ', res)
                    deviceStorage.removeItem('Push.token')
                    deviceStorage.removeItem('Push.attachedToUser')
                    deviceStorage.removeItem('Push.tokenId')
                    deviceStorage.setItem('Push.updatedAt', Date.now().toString())
                    deviceStorage.setItem('Push.enabled', 'false')
                  })
                  .catch(err => this.log('Could not delete this token from DB: ', err))
              },
              () => console.log('error on unregistering line 155')
            )
            clearInterval(this.incrementEverySecond)
          }, 15000)
        }
      })

      this.push.on('notification', data => {
        // this.log('PushHandle.Notification:', data)
        if (data.additionalData.ejson) {
          if (data.additionalData.ejson === '' + data.additionalData.ejson) {
            try {
              data.payload = EJSON.parse(data.additionalData.ejson)
              this.log('PushHandle.Parsed.EJSON.Payload:', data.payload)
            } catch (err) {
              this.log('PushHandle.Parsed.EJSON.Payload.Error', err.message, data.payload)
            }
          } else {
            data.payload = EJSON.fromJSONValue(data.additionalData.ejson)
            this.log('PushHandle.EJSON.Payload:', data.payload)
          }
        }

        // Emit alert event - this requires the app to be in foreground
        if (data.message && data.additionalData.foreground) {
          PushEventState.emit('alert', data)
        }

        // Emit sound event
        if (data.sound) {
          PushEventState.emit('sound', data)
        }

        // Emit badge event
        if (typeof data.count !== 'undefined') {
          this.log('PushHandle.SettingBadge:', data.count)
          this.setBadge(data.count, hardware.platform)
          PushEventState.emit('badge', data)
        }

        if (data.additionalData.foreground) {
          this.log('PushHandle.Message: Got message while app is open:', data)
          // TODO handle this
          PushEventState.emit('message', data)
        } else {
          this.log('PushHandle.Startup: Got message while app was closed/in background:', data)
          PushEventState.emit('startup', data)
        }
      })

      this.push.on('error', e => {
        this.log('PushHandle.Error:', e)
        PushEventState.emit('error', {
          type: hardware.platform + '.cordova',
          error: e.message
        })
      })

      PushEventState.emit('ready')
    }
  }
}

const CordovaPush = new PushHandle()
export default CordovaPush
