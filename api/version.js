import { APP_VERSION, APP_DATA_EPOCH, apiOk } from './_helpers.js';

export default async function handler(_req, res) {
  return apiOk(res, { v: APP_VERSION, epoch: APP_DATA_EPOCH });
}
