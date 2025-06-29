import { Match, check } from 'meteor/check'
import { Push } from './pushToDB'
import { Meteor } from 'meteor/meteor'
import { Tokens } from './api'

Push.appCollection = Tokens

const matchToken = Match.OneOf({ vendor: 'web', token: String }, { vendor: 'android', token: String }, { vendor: 'apn', token: String }, { vendor: 'ios', token: String })

if (process.env.SERVER_IS_PUSH_SAVER === 'true') {
  Meteor.methods({
    'token-insert': async function (options) {
      console.log('token-insert', options)

      check(options, {
        id: Match.Optional(String),
        token: matchToken,
        appName: String,
        metadata: Match.Optional(Object)
      })

      let id
      if (this.userId) {
        const { _id, tokens } = await Push.appCollection.findOneAsync({ userId: this.userId, appName: options.appName }, { fields: { _id: 1, tokens: 1 } }) || {}

        // If I already have a document for this userId
        if (_id) {
          id = _id
          if (tokens?.length) { // and if this document has tokens
            const t = tokens.findIndex(d => d.vendor === options.token.vendor && d.token === options.token.token) // find out whether this received token already exist with the user
            // If the token exists on the user, do nothing.
            if (t !== -1) {
              // console.log('I am doing nothing. I already have this token')
              // I have this token with this user, do nothing
            } else {
              // If the token doesn't exist on the user, save it.
              // console.log('I found a user but didn\'t find a token, so I insert this token for the user')
              Push.appCollection.updateAsync({ userId: this.userId }, {
                $addToSet: {
                  tokens: { ...options.token, createdAt: Date.now(), enabled: true }
                },
                $set: {
                  updatedAt: Date.now()
                }
              })
            }
          } else {
            // If a document with this userId is found but it has no tokens, add this token to the user.
            Push.appCollection.updateAsync({ userId: this.userId }, {
              $set: {
                tokens: [{ ...options.token, createdAt: Date.now() }],
                updatedAt: Date.now()
              }
            })
          }
        } else {
          id = await Push.appCollection.insertAsync({
            userId: this.userId,
            tokens: [{ ...options.token, createdAt: Date.now() }],
            updatedAt: Date.now(),
            appName: options.appName
          })
        }
      } else {
        // Check whether I have this toke in my DB. If I have it, do nothing, if I don't have it, insert it.
        id = (await Push.appCollection.findOneAsync({ appName: options.appName, vendor: options.token.vendor, token: options.token.token }, { fields: { _id: 1 } }))?._id

        if (id) {
          // console.log('a token without a user has already been found. This device is subscribed already.')
        } else {
          // вернем ошибку
          const error = new Error('Invalid push notification token or application name');
          error.code = 'INVALID_PUSH_REGISTRATION';
          throw error;

          // id = await Push.appCollection.insertAsync({
          //   ...options.token,
          //   appName: options.appName,
          //   updatedAt: Date.now()
          // })
        }
      }
      return id
    },

    /*
      token: { vendor, token }
     */

    'token-remove': async function ({ _id, token }) {
      if (this.userId) {
        Push.appCollection.updateAsync(_id, {
          $pull: { tokens: { token: token.token } },
          $set: { updatedAt: Date.now() }
        })
      } else {
        Push.appCollection.removeAsync({ _id })
      }
    },

    'token-validate': async function ({ token, vendor }) {
      console.log('token-validate', { token, vendor })
      
      check(token, String)
      check(vendor, String)

      try {
        // Ищем документ по токену и vendor
        const document = await Push.appCollection.findOneAsync({ 
          $or: [
            // Поиск в документах с токенами в массиве (авторизованные пользователи)
            { 
              tokens: { 
                $elemMatch: { 
                  token: token, 
                  vendor: vendor 
                } 
              } 
            },
            // Поиск в документах без userId (неавторизованные пользователи)
            { 
              token: token, 
              vendor: vendor,
              userId: { $exists: false }
            }
          ]
        }, { fields: { tokens: 1, userId: 1, token: 1, vendor: 1 } })
        
        if (!document) {
          console.log('Document not found for token:', token)
          return false
        }

        // Если пользователь авторизован, проверяем что документ принадлежит ему или является общим
        if (this.userId && document.userId && document.userId !== this.userId) {
          console.log('Document belongs to different user')
          return false
        }

        console.log('Token validation result: true')
        return true
      } catch (error) {
        console.error('Error validating token:', error)
        return false
      }
    }
  })
} else {
  console.info(
    '#####################################################################\n',
    'You either haven\'t set the SERVER_IS_PUSH_SAVER env var, or this was set to false and consequently this server is not a Push Sender\n',
    'All internal Push methods for saving and updating tokens or saving notifications are disabled\n',
    'coming from internalMethods.js',
    '\n#####################################################################'
  )
}
