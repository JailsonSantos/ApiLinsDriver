const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const pagarme = require('../services/pagarme');
const googleMaps = require('../services/googleMaps');

const User = require('../models/user');
const Car = require('../models/car');
const PaymentMethod = require('../models/paymentMethod');
const Ride = require('../models/ride');

const keys = require('../data/keys.json');

router.post('/signup', async (req, res) => {
  const db = mongoose.connection;
  const session = await db.startSession();
  session.startTransaction();

  try {
    const { user, car, paymentMethod } = req.body;
    let finalUser = {};

    if (user.tipo === 'M') {
      // CADASTRAR RECEBEDOR
      const createRecipient = await pagarme.createRecipient({
        name: user.nome,
        email: user.email,
      });

      if (createRecipient.error) {
        throw createRecipient.message;
      }

      // CADASTRAR MOTORISTA
      finalUser = await new User({
        ...user,
        recipientId: createRecipient.data.id,
      }).save({ session });

      // CADASTRAR VEÍCULO
      await new Car({ ...car, userId: finalUser._id }).save({ session });
    } else {
      // CADASTRAR PASSAGEIRO
      finalUser = await new User(user).save({ session });

      // CRIAR CARTÃO DE CRÉDITO
      const createCreditCard = await pagarme.createCreditCard({
        card_expiration_date: paymentMethod.validade.replace('/', ''), // 12/2023 => 122023
        card_number: paymentMethod.numero.replace(' ', ''),
        card_cvv: paymentMethod.cvv,
        card_holder_name: paymentMethod.nome,
      });

      if (createCreditCard.error) {
        throw createCreditCard.message;
      }

      // CADASTRAR CARTÃO DE CRÉDITO
      await new PaymentMethod({
        cardId: createCreditCard.data.id,
        userId: finalUser._id,
      }).save({ session });
    }

    await session.commitTransaction();
    session.endSession();

    res.json({ error: false, user: finalUser });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    res.json({ error: true, message: err.message });
  }
});

router.post('/check-user', async (req, res) => {
  try {
    const user = await User.findOne({
      email: req.body.email,
    });

    res.json({ error: false, user });
  } catch (err) {
    res.json({ error: true, message: err.message });
  }
});

router.put('/location/:id', async (req, res) => {
  try {
    const { io } = req.app;
    const { id } = req.params;
    const { coordinates, socketId, status } = req.body;

    await User.findByIdAndUpdate(id, {
      location: {
        type: 'Point',
        coordinates,
      },
    });

    if (socketId && status === 'inRide') {
      io.to(socketId).emit('ride-update', coordinates);
    }

    res.json({ error: false });
  } catch (err) {
    res.json({ error: true, message: err.message });
  }
});

router.put('/socket/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { socketId } = req.body;

    await User.findByIdAndUpdate(id, {
      socketId,
    });

    res.json({ error: false });
  } catch (err) {
    res.json({ error: true, message: err.message });
  }
});

router.get('/address/:address', async (req, res) => {
  try {
    const list = await googleMaps.getPlaces(
      encodeURIComponent(req.params.address)
    );

    if (list.error) {
      throw list.message;
    }

    const addressList = list.data.predictions.map((addr) => {
      const {
        place_id,
        description,
        structured_formatting: { secondary_text },
      } = addr;

      return { place_id, description, secondary_text };
    });

    res.json({ error: false, list: addressList });
  } catch (err) {
    res.json({ error: true, message: err.message });
  }
});

router.post('/pre-ride', async (req, res) => {
  try {
    const { origin, destination } = req.body;

    const routeRequest = await googleMaps.getRoute(origin, destination);
    if (routeRequest.error) {
      throw routeRequest.message;
    }

    const {
      distance,
      duration,
      start_address,
      end_address,
      steps,
    } = routeRequest.data.routes[0].legs[0];

    const route = steps
      .map((step) => {
        return [
          {
            latitude: step.start_location.lat,
            longitude: step.start_location.lng,
          },
          {
            latitude: step.end_location.lat,
            longitude: step.end_location.lng,
          },
        ];
      })
      .flat(1);

    const price = ((distance.value / 1000) * 2.67).toFixed(2);

    res.json({
      error: false,
      info: { distance, duration, start_address, end_address, route, price },
    });
  } catch (err) {
    res.json({ error: true, message: err.message });
  }
});

router.post('/call-ride', async (req, res) => {
  try {
    const { io } = req.app;
    const { info, userId } = req.body;

    // LER DADOS DO PASSAGEIRO
    const user = await User.findById(userId).select(
      '_id nome fbId socketId accessToken cpf email'
    );

    const drivers = await User.aggregate([
      // TODOS OS MOTORISTAS EM UM RAIO DE 5KM
      {
        $geoNear: {
          near: {
            type: 'Point',
            coordinates: [info.route[0].latitude, info.route[0].longitude],
          },
          distanceField: 'location',
          spherical: true,
          maxDistance: 5 * 1000, // METERS
        },
      },
      // ACHAR TODOS OS MOTORISTAS
      { $match: { tipo: 'M' } },
      // TODOS OS MOTORISTAS QUE NÃO ESTÃO EM CORRIDA
      {
        $lookup: {
          from: 'rides',
          as: 'activeRides',
          let: {
            driverId: '$_id',
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$driverId', '$$driverId'] },
                    { $eq: ['$status', 'A'] },
                  ],
                },
              },
            },
          ],
        },
      },
      // REMOVER OS MOTORISTAS QUE ESTÃO EM CORRIDA
      {
        $match: {
          'activeRides.driverId': {
            $exists: false,
          },
        },
      },
    ]);

    if (drivers.length) {
      drivers.map((driver) => {
        io.sockets.sockets
          .get(driver.socketId)
          .emit('ride-request', { info, user });
      });

      res.json({ error: false, ride: { info, user } });
    } else {
      res.json({ error: true, message: 'Nenhum motorista disponível' });
    }
  } catch (err) {
    res.json({ error: true, message: err.message });
  }
});

router.post('/accept-ride', async (req, res) => {
  try {
    const { io } = req.app;
    const { info, user, driverId } = req.body;

    const rideId = mongoose.Types.ObjectId();

    // DADOS DE CARTÃO DE CRÉDITO
    const paymentMethod = await PaymentMethod.findOne({
      userId: user._id,
    }).select('cardId');

    // DADOS DO MOTORISTA
    const driver = await User.findById(driverId).select(
      '_id nome fbId accessToken recipientId'
    );

    // DADOS DO CARRO
    const car = await Car.findOne({
      userId: driverId,
    }).select('placa marca modelo cor');

    // SOCKETS
    let usersSocket = await User.find({
      $or: [
        { _id: mongoose.Types.ObjectId(user._id) },
        { _id: mongoose.Types.ObjectId(driverId) },
      ],
    }).select('-_id socketId');

    usersSocket = usersSocket.map((u) => user.socketId);

    // CRIAR O PAGAMENTO
    const finalPrice = parseInt(info.price.replace('.', '').replace(',', ''));
    const createPayment = await pagarme.createSplitTransaction({
      amount: finalPrice,
      card_id: paymentMethod.cardId,
      customer: {
        external_id: user._id,
        name: user.nome,
        type: 'individual',
        country: 'br',
        email: user.email,
        documents: [
          {
            type: 'cpf',
            number: user.cpf,
          },
        ],
        phone_numbers: ['+5511999998888'],
        birthday: '1997-03-21',
      },
      billing: {
        name: 'Trinity Moss',
        address: {
          country: 'br',
          state: 'sp',
          city: 'Cotia',
          neighborhood: 'Rio Cotia',
          street: 'Rua Matrix',
          street_number: '9999',
          zipcode: '06714360',
        },
      },
      items: [
        {
          id: rideId,
          title: rideId,
          unit_price: finalPrice,
          quantity: 1,
          tangible: false,
        },
      ],
      split_rules: [
        {
          recipient_id: keys.recipient_id,
          percentage: keys.app_fee,
          liable: true,
          charge_processing_fee: true,
        },
        {
          recipient_id: driver.recipientId,
          percentage: 100 - keys.app_fee,
          liable: true,
          charge_processing_fee: true,
        },
      ],
    });

    if (createPayment.error) {
      throw { message: createPayment.message };
    }

    // CRIAR O REGISTRO DA CORRIDA NO BANCO DE DADOS
    const ride = await new Ride({
      _id: rideId,
      info,
      userId: user._id,
      driverId,
      transactionId: createPayment.data.id,
    }).save();

    // COLCOAR OS USUARIOS EM UM ROOM PARA ATUALIZAR A POSIÇÃO DO MOTORISTA NO MAPA
    usersSocket.map((socketId) => {
      io.sockets.sockets.get(socketId).join(rideId);
    });

    // EMITIR QUE A CORRIDA FOI ACEIRA, COM OS RESPECTIVOS DADOS
    const finalData = { _id: rideId, info, user, driver, car };
    io.to(rideId).emit('ride', finalData);
    res.json({ error: false, ride: finalData });
  } catch (err) {
    res.json({ error: true, message: err.message });
  }
});

module.exports = router;
