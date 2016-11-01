// Copyright 2016, Google, Inc.
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

// [START functions_ocr_setup]
const async = require('async');
const config = require('./config.json');

// Get a reference to the Pub/Sub component
const pubsub = require('@google-cloud/pubsub')();
// Get a reference to the Cloud Storage component
const storage = require('@google-cloud/storage')();
// Get a reference to the Cloud Vision API component
const vision = require('@google-cloud/vision')();
// Get a reference to the Translate API component
const translate = require('@google-cloud/translate')({
  key: config.TRANSLATE_API_KEY
});
// [END functions_ocr_setup]

// [START functions_ocr_publish]
/**
 * Publishes the result to the given pubsub topic and returns a Promise.
 *
 * @param {string} topicName Name of the topic on which to publish.
 * @param {Object} data The data to publish.
 * @param {Function} callback Callback function.
 */
function publishResult (topicName, data, callback) {
  return pubsub.topic(topicName).get({
    autoCreate: true
  }, function (err, topic) {
    if (err) {
      return callback(err);
    }
    // Pub/Sub messages must be valid JSON objects with a data property.
    return topic.publish({
      data: data
    }, callback);
  });
}
// [END functions_ocr_publish]

// [START functions_ocr_detect]
/**
 * Detects the text in an image using the Google Vision API.
 *
 * @param {object} file Cloud Storage File instance.
 * @returns {Promise}
 */
function detectText (file) {
  let text;

  console.log(`Looking for text in image ${file.name}`);
  return vision.detectText(file)
    .then(([_text]) => {
      text = _text;
      console.log(`Extracted text from image (${text.length} chars)`);
      return translate.detect(text);
    })
    .then(([translation]) => {
      console.log(`Detected language "${translation.language}" for ${file.name}`);

      // Submit a message to the bus for each language we're going to translate to
      const tasks = config.TO_LANG.map((lang) => {
        const topicName = config.TRANSLATE_TOPIC;
        if (translation.language === lang) {
          topicName = config.RESULT_TOPIC;
        }
        const payload = {
          text: text,
          filename: file.name,
          lang: lang,
          from: translation.language
        };
        return publishResult(topicName, payload);
      });

      return Promise.all(tasks);
    });
}
// [END functions_ocr_detect]

// [START functions_ocr_rename]
/**
 * Appends a .txt suffix to the image name.
 *
 * @param {string} filename Name of a file.
 * @param {string} lang Language to append.
 * @returns {string} The new filename.
 */
function renameImageForSave (filename, lang) {
  var dotIndex = filename.indexOf('.');
  var suffix = '_to_' + lang + '.txt';
  if (dotIndex !== -1) {
    filename = filename.replace(/\.[^/.]+$/, suffix);
  } else {
    filename += suffix;
  }
  return filename;
}
// [END functions_ocr_rename]

// [START functions_ocr_process]
/**
 * Cloud Function triggered by Cloud Storage when a file is uploaded.
 *
 * @param {Object} context Cloud Function context.
 * @param {Function} context.success Success callback.
 * @param {Function} context.failure Failure callback.
 * @param {Object} data Request data, in this case an object provided by Cloud Storage.
 * @param {string} data.bucket Name of the Cloud Storage bucket.
 * @param {string} data.name Name of the file.
 * @param {string} [data.timeDeleted] Time the file was deleted if this is a deletion event.
 * @see https://cloud.google.com/storage/docs/json_api/v1/objects#resource
 */
exports.processImage = function processImage (event) {
  return Promise.resolve(event.data)
    .then((file) => {
      if (file.resourceState === 'not_exists') {
        // This was a deletion event, we don't want to process this
        return;
      }

      if (!file.bucket) {
        throw new Error('Bucket not provided. Make sure you have a "bucket" property in your request');
      }
      if (!file.name) {
        throw new Error('Filename not provided. Make sure you have a "name" property in your request');
      }

      file = storage.bucket(file.bucket).file(file.name);

      return detectText(file);
    })
    .then((file) => {
      console.log(`File ${file.name} processed.`);
    });
};
// [END functions_ocr_process]

// [START functions_ocr_translate]
/**
 * Translates text using the Google Translate API. Triggered from a message on
 * a Pub/Sub topic.
 *
 * @param {Object} context Cloud Function context.
 * @param {Function} context.success Success callback.
 * @param {Function} context.failure Failure callback.
 * @param {Object} data Request data, in this case an object provided by the Pub/Sub trigger.
 * @param {Object} data.text Text to be translated.
 * @param {Object} data.filename Name of the filename that contained the text.
 * @param {Object} data.lang Language to translate to.
 */
exports.translateText = function translateText (context, data) {
  try {
    if (!data.text) {
      throw new Error('Text not provided. Make sure you have a ' +
        '"text" property in your request');
    }
    if (!data.filename) {
      throw new Error('Filename not provided. Make sure you have a ' +
        '"filename" property in your request');
    }
    if (!data.lang) {
      throw new Error('Language not provided. Make sure you have a ' +
        '"lang" property in your request');
    }

    console.log('Translating text into ' + data.lang);
    return translate.translate(data.text, {
      from: data.from,
      to: data.lang
    }, function (err, translation) {
      if (err) {
        console.error(err);
        return context.failure(err);
      }

      return publishResult(config.RESULT_TOPIC, {
        text: translation,
        filename: data.filename,
        lang: data.lang
      }, function (err) {
        if (err) {
          console.error(err);
          return context.failure(err);
        }
        console.log('Text translated to ' + data.lang);
        return context.success();
      });
    });
  } catch (err) {
    console.error(err);
    return context.failure(err.message);
  }
};
// [END functions_ocr_translate]

// [START functions_ocr_save]
/**
 * Saves the data packet to a file in GCS. Triggered from a message on a Pub/Sub
 * topic.
 *
 * @param {Object} context Cloud Function context.
 * @param {Function} context.success Success callback.
 * @param {Function} context.failure Failure callback.
 * @param {Object} data Request data, in this case an object provided by the Pub/Sub trigger.
 * @param {Object} data.text Text to save.
 * @param {Object} data.filename Name of the filename that contained the text.
 * @param {Object} data.lang Language of the text.
 */
exports.saveResult = function saveResult (context, data) {
  try {
    if (!data.text) {
      throw new Error('Text not provided. Make sure you have a ' +
        '"text" property in your request');
    }
    if (!data.filename) {
      throw new Error('Filename not provided. Make sure you have a ' +
        '"filename" property in your request');
    }
    if (!data.lang) {
      throw new Error('Language not provided. Make sure you have a ' +
        '"lang" property in your request');
    }

    console.log('Received request to save file ' + data.filename);

    var bucketName = config.RESULT_BUCKET;
    var filename = renameImageForSave(data.filename, data.lang);
    var file = storage.bucket(bucketName).file(filename);

    console.log('Saving result to ' + filename + ' in bucket ' + bucketName);

    file.save(data.text, function (err) {
      if (err) {
        console.error(err);
        return context.failure(err);
      }
      console.log('Text written to ' + filename);
      return context.success();
    });
  } catch (err) {
    console.error(err);
    return context.failure(err.message);
  }
};
// [END functions_ocr_save]
