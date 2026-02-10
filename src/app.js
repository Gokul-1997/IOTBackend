const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());
require('./routes')(app);
app.use(require('./middleware/error.middleware'));

module.exports = app;
