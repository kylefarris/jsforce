/**
 * @file Represents stream that handles Salesforce record as stream data
 * @author Shinichi Tomita <shinichi.tomita@gmail.com>
 */

'use strict';

var events = require('events'),
    stream = require('readable-stream'),
    Duplex = stream.Duplex,
    Transform = stream.Transform,
    PassThrough = stream.PassThrough,
    through2 = require('through2'),
    inherits = require('inherits'),
    _      = require('lodash/core'),
    CSV    = require('./csv');


/**
 * Class for Record Stream
 *
 * @class
 * @constructor
 * @extends stream.Transform
 */
var RecordStream = module.exports = function() {
  RecordStream.super_.call(this, { objectMode: true });
};

inherits(RecordStream, Transform);


/*
 * @override
 */
RecordStream.prototype._transform = function(record, enc, callback) {
  this.emit('record', record);
  this.push(record);
  callback();
};

/**
 * Get record stream of queried records applying the given mapping function
 *
 * @param {RecordMapFunction} fn - Record mapping function
 * @returns {RecordStream}
 */
RecordStream.prototype.map = function(fn) {
  return this.pipe(RecordStream.map(fn));
};

/**
 * Get record stream of queried records, applying the given filter function
 *
 * @param {RecordFilterFunction} fn - Record filtering function
 * @returns {RecordStream}
 */
RecordStream.prototype.filter = function(fn) {
  return this.pipe(RecordStream.filter(fn));
};


/**
 * @class RecordStream.Serializable
 * @extends {RecordStream}
 */
var Serializable = RecordStream.Serializable = function() {
  Serializable.super_.call(this);
  this._dataStream = null;
};

inherits(Serializable, RecordStream);

/**
 * Create readable data stream which emits serialized record data
 *
 * @param {String} [type] - Type of outgoing data format. Currently 'csv' is default value and the only supported.
 * @param {Object} [options] - Options passed to converter
 * @returns {stream.Readable}
*/
Serializable.prototype.stream = function(type, options) {
  type = type || 'csv';
  var converter = DataStreamConverters[type];
  if (!converter) {
    throw new Error('Converting [' + type + '] serializable data stream is not supported.');
  }
  if (!this._dataStream) {
    this._dataStream = new PassThrough();
    this.pipe(converter.serialize(options))
      .pipe(this._dataStream);
  }
  return this._dataStream;
};


/**
 * @class RecordStream.Parsable
 * @extends {RecordStream}
 */
var Parsable = RecordStream.Parsable = function() {
  Parsable.super_.call(this);
  this._dataStream = null;
};

inherits(Parsable, RecordStream);

/**
 * Create writable data stream which accepts serialized record data
 *
 * @param {String} [type] - Type of outgoing data format. Currently 'csv' is default value and the only supported.
 * @param {Object} [options] - Options passed to converter
 * @returns {stream.Readable}
*/
Parsable.prototype.stream = function(type, options) {
  type = type || 'csv';
  var converter = DataStreamConverters[type];
  if (!converter) {
    throw new Error('Converting [' + type + '] parsable data stream is not supported.');
  }
  if (!this._dataStream) {
    this._dataStream = new PassThrough();
    if (type !== 'zip') {
        this._parserStream = converter.parse(options);
        this._parserStream.pipe(this).pipe(new PassThrough({ objectMode: true, highWaterMark: ( 500 * 1000 ) }));
    } else {
        console.log("parsable zip thingy");
        this._parserStream = converter.parse(options);
        this._parserStream.pipe(this).pipe(new PassThrough({ objectMode: false, highWaterMark: ( 500 * 1000 ) }));
        this.pipe(this._dataStream);
    }
  }
  return this._dataStream;
};


/* @override */
Parsable.prototype.on = function(ev, fn) {
  if (ev === 'readable' || ev === 'record') {
    this._dataStream.pipe(this._parserStream);
  }
  return Parsable.super_.prototype.on.call(this, ev, fn);
};

/* @override */
Parsable.prototype.addListener = Parsable.prototype.on;

/* --------------------------------------------------- */

/**
 * @callback RecordMapFunction
 * @param {Record} record - Source record to map
 * @returns {Record}
 */

/**
 * Create a record stream which maps records and pass them to downstream
 *
 * @param {RecordMapFunction} fn - Record mapping function
 * @returns {RecordStream.Serializable}
 */
RecordStream.map = function(fn) {
  var mapStream = new RecordStream.Serializable();
  mapStream._transform = function(record, enc, callback) {
    var rec = fn(record) || record; // if not returned record, use same record
    this.push(rec);
    callback();
  };
  return mapStream;
};

/**
 * Create mapping stream using given record template
 *
 * @param {Record} record - Mapping record object. In mapping field value, temlate notation can be used to refer field value in source record, if noeval param is not true.
 * @param {Boolean} [noeval] - Disable template evaluation in mapping record.
 * @returns {RecordStream.Serializable}
 */
RecordStream.recordMapStream = function(record, noeval) {
  return RecordStream.map(function(rec) {
    var mapped = { Id: rec.Id };
    for (var prop in record) {
      mapped[prop] = noeval ? record[prop] : evalMapping(record[prop], rec);
    }
    return mapped;
  });

  function evalMapping(value, mapping) {
    if (_.isString(value)) {
      var m = /^\$\{(\w+)\}$/.exec(value);
      if (m) { return mapping[m[1]]; }
      return value.replace(/\$\{(\w+)\}/g, function($0, prop) {
        var v = mapping[prop];
        return _.isNull(v) || _.isUndefined(v) ? "" : String(v);
      });
    } else {
      return value;
    }
  }
};

/**
 * @callback RecordFilterFunction
 * @param {Record} record - Source record to filter
 * @returns {Boolean}
 */

/**
 * Create a record stream which filters records and pass them to downstream
 *
 * @param {RecordFilterFunction} fn - Record filtering function
 * @returns {RecordStream.Serializable}
 */
RecordStream.filter = function(fn) {
  var filterStream = new RecordStream.Serializable();
  filterStream._transform = function(record, enc, callback) {
    if (fn(record)) { this.push(record); }
    callback();
  };
  return filterStream;
};

/** ---------------------------------------------------------------------- **/

/**
 * @private
 */
var CSVStreamConverter = {
  serialize: function(options) {
    options = options || {};
    var wroteHeaders = false;
    var headers = options.headers;
    return through2({ writableObjectMode: true },
      function transform(record, enc, callback) {
        if (!wroteHeaders) {
          if (!headers) {
            headers = CSV.extractHeaders([ record ]);
          }
          this.push(CSV.arrayToCSV(headers) + '\n', 'utf8');
          wroteHeaders = true;
        }
        this.push(CSV.recordToCSV(record, headers, { nullValue: options.nullValue }) + '\n', 'utf8');
        callback();
      }
    );
  },

  parse: function() {
    var buf = [];
    return through2({ readableObjectMode: true },
      function transform(data, enc, callback) {
        buf.push(data);
        callback();
      },
      function flush(callback) {
        var data = buf.map(function(d) {
          return d.toString('utf8');
        }).join('');
        var records = CSV.parseCSV(data);
        var _this = this;
        records.forEach(function(record) {
          _this.push(record);
        });
        this.push(null);
        callback();
      }
    );
  }
};

var ZIPStreamPassthrough = {
    serialize: function(options) {
        return through2({ writableObjectMode: false }, function transform(record, enc, callback) {
            this.push(record);
            callback();
        });
    },
    parse: function() {
        var buf = [];
        return through2({ readableObjectMode: true }, function transform(data, enc, callback) {
            buf.push(data);
            callback();
        }, function flush(callback) {
            this.push(null);
            callback();
        });
    }
};

/**
 * @private
 */
var DataStreamConverters = RecordStream.DataStreamConverters = {
  csv: CSVStreamConverter,
  zip: ZIPStreamPassthrough
};
