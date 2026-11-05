import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const options = { allErrors: true, strict: true, ownProperties: true };
const standard = addFormats(new Ajv(options));
const modern = addFormats(new Ajv2020(options));

export function compileSchema(schema) {
  return (schema?.$schema?.includes('2020-12') ? modern : standard).compile(schema);
}
