/**
 * Late-ES API shim for Safari 17.1 (iOS 17.0–17.3), which dsh's client bundles
 * target above.
 *
 * Encountered so far:
 *   - AbortSignal.any          (Safari 17.4) — workspace directory listing
 *   - Iterator helpers         (Safari 18.4) — see iterator-polyfill.js
 *
 * Rather than shipping one shim per failure, this file covers the additions
 * from Safari 17.4 through 18.0 that a modern web app is likely to reach for:
 *
 *   AbortSignal.any          17.4
 *   Promise.withResolvers    17.4
 *   Object.groupBy           17.4
 *   Map.groupBy              17.4
 *   Array.fromAsync          18.0
 *   URL.canParse / URL.parse 17.0 / 18.2
 *   RegExp.escape            18.2 — pdf.js text extraction (Unicode normalisation)
 *
 * Every block is guarded, so a newer engine keeps its native implementation and
 * this file becomes a no-op. Loaded as a classic script before the module entry.
 */
(function () {
  'use strict';

  // ---- AbortSignal.any (Safari 17.4) -------------------------------------
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any !== 'function') {
    AbortSignal.any = function any(signals) {
      var controller = new AbortController();
      var list = Array.from(signals);

      for (var i = 0; i < list.length; i += 1) {
        var signal = list[i];
        if (signal === undefined || signal === null) {
          throw new TypeError('AbortSignal.any: every entry must be an AbortSignal');
        }
        if (signal.aborted) {
          controller.abort(signal.reason);
          return controller.signal;
        }
      }

      for (var j = 0; j < list.length; j += 1) {
        (function (signal) {
          signal.addEventListener('abort', function () {
            controller.abort(signal.reason);
          }, { once: true });
        })(list[j]);
      }

      return controller.signal;
    };
  }

  // ---- Promise.withResolvers (Safari 17.4) -------------------------------
  if (typeof Promise.withResolvers !== 'function') {
    Promise.withResolvers = function withResolvers() {
      var resolve;
      var reject;
      var promise = new Promise(function (res, rej) {
        resolve = res;
        reject = rej;
      });
      return { promise: promise, resolve: resolve, reject: reject };
    };
  }

  // ---- Object.groupBy / Map.groupBy (Safari 17.4) ------------------------
  if (typeof Object.groupBy !== 'function') {
    Object.groupBy = function groupBy(items, callback) {
      var result = Object.create(null);
      var index = 0;
      for (var item of items) {
        var key = callback(item, index);
        index += 1;
        if (!Object.prototype.hasOwnProperty.call(result, key)) result[key] = [];
        result[key].push(item);
      }
      return result;
    };
  }

  if (typeof Map.groupBy !== 'function') {
    Map.groupBy = function groupBy(items, callback) {
      var result = new Map();
      var index = 0;
      for (var item of items) {
        var key = callback(item, index);
        index += 1;
        if (!result.has(key)) result.set(key, []);
        result.get(key).push(item);
      }
      return result;
    };
  }

  // ---- Array.fromAsync (Safari 18.0) ------------------------------------
  if (typeof Array.fromAsync !== 'function') {
    Array.fromAsync = function fromAsync(items, mapFn, thisArg) {
      return (async function () {
        var out = [];
        if (items === null || items === undefined) {
          throw new TypeError('Array.fromAsync: items must be iterable or array-like');
        }
        var index = 0;
        if (typeof items[Symbol.asyncIterator] === 'function' || typeof items[Symbol.iterator] === 'function') {
          for await (var value of items) {
            out.push(typeof mapFn === 'function' ? await mapFn.call(thisArg, value, index) : value);
            index += 1;
          }
          return out;
        }
        // Array-like of promises / values.
        var length = Number(items.length) || 0;
        for (var i = 0; i < length; i += 1) {
          var entry = await items[i];
          out.push(typeof mapFn === 'function' ? await mapFn.call(thisArg, entry, i) : entry);
        }
        return out;
      })();
    };
  }

  // ---- URL.canParse / URL.parse (Safari 17.0 / 18.2) ---------------------
  // The bundle calls URL.canParse unguarded inside its link classifier, which a
  // 16.3 engine would otherwise turn into a TypeError on first message render.
  if (typeof URL !== 'undefined' && typeof URL.canParse !== 'function') {
    URL.canParse = function canParse(input, base) {
      try {
        new URL(input, base);
        return true;
      } catch (error) {
        return false;
      }
    };
  }

  if (typeof URL !== 'undefined' && typeof URL.parse !== 'function') {
    URL.parse = function parse(input, base) {
      try {
        return new URL(input, base);
      } catch (error) {
        return null;
      }
    };
  }

  // ---- RegExp.escape (Safari 18.2) ---------------------------------------
  // pdf.js builds its Unicode-normalisation patterns from user text with
  // RegExp.escape, which a 16.3 engine does not have. Escaping is done with
  // \xHH rather than a backslash: in /u patterns an identity escape such as
  // "\ " or "\-" is a SyntaxError, while \xHH is always a literal.
  if (typeof RegExp.escape !== 'function') {
    RegExp.escape = function escape(value) {
      var source = String(value);
      var out = '';
      for (var i = 0; i < source.length; i += 1) {
        var code = source.charCodeAt(i);
        var ch = source.charAt(i);
        if (code > 0x7e) {
          out += ch;
        } else if (code >= 0x30 && code <= 0x39 || code >= 0x41 && code <= 0x5a || code >= 0x61 && code <= 0x7a) {
          out += i === 0 ? '\\x' + ('0' + code.toString(16)).slice(-2) : ch;
        } else {
          out += '\\x' + ('0' + code.toString(16)).slice(-2);
        }
      }
      return out;
    };
  }
})();
