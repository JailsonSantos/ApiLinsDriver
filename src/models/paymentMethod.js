const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const paymentMethod = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  cardId: { type: String, required: true },
  dataCadastro: {
    type: Date,
    default: Date.now(),
  },
});

module.exports = mongoose.model('PaymentMethod', paymentMethod);
