import * as express from 'express';
import * as path from 'path';
import { Pool, Client, PoolConfig } from 'pg';
import { postgraphile } from 'postgraphile';
import * as PgManyToManyPlugin from '@graphile-contrib/pg-many-to-many';
import * as jwks from 'jwks-rsa';
import * as jwt from 'express-jwt';
import * as fileUpload from 'express-fileupload';
import * as cors from 'cors';
import { release } from 'os';
import * as bodyParser from 'body-parser';
import { UserRequest, UserIncomingMessage } from './types';
import * as fs from 'fs';
import * as AWS from 'aws-sdk';
import * as nodemailer from 'nodemailer';

const app = express();
const stripe = require('stripe')(process.env.STRIPE_API_KEY);

app.use(fileUpload());
app.use(cors());

// app.use('/.storybook/', express.static(path.join(__dirname, '../web/build/storybook')));
// app.get('/.storybook/*', function (req, res) {
//   res.sendFile(path.join(__dirname, '../web/build/storybook', 'index.html'));
// });

// app.use('/', express.static(path.join(__dirname, '../web/build')));
// app.get('/*', function (req, res) {
//   res.sendFile(path.join(__dirname, '../web/build', 'index.html'));
// });

app.use(jwt({
  secret: jwks.expressJwtSecret({
    cache: true,
    rateLimit: true,
    jwksRequestsPerMinute: 5,
    jwksUri: 'https://regen-network-registry.auth0.com/.well-known/jwks.json'
  }),
  credentialsRequired: false,
  audience: 'https://regen-registry-server.herokuapp.com/',
  issuer: 'https://regen-network-registry.auth0.com/',
  algorithms: ['RS256']
}));

const pgPoolConfig: PoolConfig = {
  connectionString: process.env.DATABASE_URL || 'postgres://postgres@localhost:5432/xrn',
};

if (process.env.NODE_ENV === 'production') {
  pgPoolConfig.ssl = {
    ca: fs.readFileSync('../config/rds-combined-ca-bundle.pem'),
  };
}

const pgPool = new Pool(pgPoolConfig);

// create Nodemailer SES transporter
const transporter = nodemailer.createTransport({
  SES: new AWS.SES({
    apiVersion: "2010-12-01",
    accessKeyId: process.env.AWS_SES_KEY_ID || "",
    secretAccessKey: process.env.AWS_SES_ACCESS_KEY || "",
    region: "us-east-1",
  }),
});

app.post('/email', async (req, res) => {
  // send some mail
  transporter.sendMail(
    {
      from: "marie@regen.network",
      to: "marie.gauthier63@gmail.com",
      subject: "Test Message",
      text:
        "I hope this message gets sent!",
      // ses: {
      //   // optional extra arguments for SendRawEmail
      //   Tags: [
      //     {
      //       Name: "tag name",
      //       Value: "tag value",
      //     },
      //   ],
      // },
    },
    (err, info) => {
      if (err) {
        console.log(err);
        res.sendStatus(500);
      }
      if (info) {
        console.log(info.envelope);
        console.log(info.messageId);
        res.sendStatus(200);
      }
    }
  );
});

app.post('/api/login', bodyParser.json(), (req: UserRequest, res: express.Response) => {
  // Create Postgres ROLE for Auth0 user
  if(req.user && req.user.sub) {
    const sub = req.user.sub;
    pgPool.connect((err, client, release) => {
      if (err) {
        res.sendStatus(500);
        console.error('Error acquiring postgres client', err.stack);
      } else {
        client.query('SELECT private.create_app_user_if_needed($1)', [sub], (err, qres) => {
          if (err) {
            res.sendStatus(500);
            console.error('Error creating role', err.stack);
          } else {
            // create user and associated party if needed
            client.query('SELECT private.really_create_user_if_needed($1, $2, $3, $4, NULL)',
              [req.body.email, req.body.nickname, req.body.picture, sub],
              (err, qres) => {
                release();
                if (err) {
                  res.sendStatus(500);
                  console.error('Error creating user', err.stack);
                } else {
                  res.sendStatus(200);
                }
            });
          }
        });
      }
    });
  } else {
    res.sendStatus(200);
  }
});

app.post('/webhook', bodyParser.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_ENDPOINT_SECRET);
  } catch (err) {
    res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      const clientReferenceId = session['client_reference_id']; // buyer wallet id
      const items = session['display_items'];
      if (items.length) {
        const item = items[0];
        try {
          const client = await pgPool.connect();
          try {
            const product = await stripe.products.retrieve(item.product);
            try {
              const { walletId, addressId } = JSON.parse(clientReferenceId);
              const qres = await client.query('SELECT transfer_credits($1, $2, $3, $4, $5, $6, uuid_nil(), $7, $8)',
              [product.metadata.vintage_id, walletId, addressId,
              item.quantity, item.amount / 100, 'succeeded', session.id, 'stripe_checkout']);
              console.log(qres);
              res.sendStatus(200);
            } catch (err) {
              res.sendStatus(500);
              console.error('Error transfering credits', err);
            }
          } catch (err) {
            res.sendStatus(500);
            console.error('Error getting Stripe product', err);
          }
          finally {
            client.release();
          }
        } catch (err) {
          res.sendStatus(500);
          console.error('Error acquiring postgres client', err);
        }
      } else {
        return res.status(400).end();
      }
      break;
    default:
      // Unexpected event type
      return res.status(400).end();
  }

  // Return a 200 res to acknowledge receipt of the event
  res.json({ received: true });
});

app.use(postgraphile(pgPool, 'public', {
  graphiql: true,
  watchPg: true,
  dynamicJson: true,
  appendPlugins: [PgManyToManyPlugin],
  pgSettings: (req: UserIncomingMessage) => {
    if(req.user && req.user.sub) {
      const { sub, ...user } = req.user;
      const settings = { role: sub };
      // TODO need to deal with keys that aren't strings properly
      // Object.keys(user).map(k =>
      //   settings['jwt.claims.' + k] = user[k]
      // );
      return settings;
    } else return { role: 'app_user' };
   }
}));


const port = process.env.PORT || 5000;

app.listen(port);

console.log("Started server on port " + port);
console.log("Graphiql UI at http://localhost:" + port + "/graphiql");
