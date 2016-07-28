#!/usr/bin/env node

var minimist  = require('minimist');
var fs        = require('fs');
var path      = require('path');
var sprintf   = require('sprintf-js').sprintf;
var charsetDetector
              = require("node-icu-charset-detector");
var iconv     = require('iconv-lite');
var cheerio   = require('cheerio');

var argv = minimist(process.argv.slice(2), {
    alias: {
        'encoding': 'e',
        'help': 'h',
        'output': 'o',
        'time-offset': 't',
    },
    boolean: [ 'n' ]
});

//console.log(process.argv);

if (argv.h || argv._.length == 0) {
    console.log(
        'Usage: smi2srt [options] input.smi\n' +
        'Options:\n' +
        '  -e, --encoding      specify the encoding of input file\n' +
        '  -h, --help          show usage information\n' +
        '  -n                  do not overwrite an existing file\n' +
        '  -o, --output FILE   write to FILE\n' +
        '  -t, --time-offset   specify the time offset in miliseconds\n'
    );

    return 0;
}

var optSrc = argv._[0];
var optDest = argv.o;
var optEncoding = argv.e;   // || "CP949";
var optTimeOffset = argv.t || 0;

var srcName = optSrc;
var srcExt;
var srcLang;

var sv = srcName.match(/^(.*?)(?:\.(en|eng|ko|kor|ja|jap))?(?:\.(smi|smil|srt))?$/);
if (sv) {
    srcName = sv[1];
    srcLang = sv[2];
    srcExt = sv[3];

    if (!optEncoding && srcExt == 'srt')
        optEncoding = 'utf8';
}

var buffer = fs.readFileSync(optSrc);
var charset;

if (charsetDetector)
    charset = charsetDetector.detectCharset(buffer).toString();
else {
    charset = optEncoding || 'CP949';
    if (buffer[0] == 0xef && buffer[1] == 0xbb && buffer[2] == 0xbf)    // \uFEFF (BOM)
        charset = 'utf8';
    else if (buffer[0] == 0xff && buffer[1] == 0xfe)
        charset = 'utf16-le';
    else if (buffer[0] == 0xfe && buffer[1] == 0xff)
        charset = 'utf16-be';
}

var text = iconv.decode(buffer, charset).replace(/\r\n/g, '\n');

if (/^[\n\s]*<SAMI/i.test(text)) {
    var syncs = text.match(/(<SYNC[^]*?)(?=\s*<SYNC|\s*<\/BODY)/gi);
    if (!syncs) {
        console.log("No sync found");
        return;
    }

    var syncWithLang = {};
    syncs.forEach(function (sync, idx) {
        var sync = cheerio.load(sync.replace(/&nbsp(?!;)/i, '&nbsp;'), {
             normalizeWhitespace:true,
                         xmlMode:false,
                  decodeEntities:false
        }).html();
        var lang = sync.match(/class="(.*?)"/) [1];
        if (!syncWithLang[lang])
            syncWithLang[lang] = [];
        syncWithLang[lang].push(sync);
        // syncs[idx] = sync;
        // console.log(syncs[idx]);
    });

    for (var lang in syncWithLang) {
        var syncs = syncWithLang[lang];
        var outputFile = optDest;

        if (!outputFile) {
            var langCode = lang;
            if (/^(en|eg)/i.test(lang))
                langCode = 'en';
            else if (/^(kr|ko)/i.test(lang))
                langCode = 'ko';

            // FIX-ME
            if (Object.keys(syncWithLang).length == 1)
                langCode = srcLang || 'ko';

            outputFile = srcName + '.' + langCode + '.srt';
        }

        if (argv.n) {
            if (fs.existsSync(outputFile)) {
                console.log("File exists:", path.basename(outputFile));
                continue;
            }
        }

        console.log(outputFile);

        var $ = cheerio.load(syncs.join(), { decodeEntities:false });
        var j = 1;
        var fd = fs.openSync(outputFile, 'w');

        $('sync').each(function (i, e) {
            var sync = $(e);
            var start = parseInt(sync.attr('start'));
            var end = parseInt(sync.next().attr('start'));

            if (!end)
                return;
            if (start > end) {
                var nextStart = sync.next().next().attr('start');
                if (nextStart && nextStart - start > 500) {
                    var newEnd = start + Math.floor(Math.min(3000, (nextStart - start) / 2));
                    console.log('Sync adjusted: start=' + start + ', end=' + end + ' -> ' + newEnd);
                    end = newEnd;
                }
                else
                    throw new Error('Sync invalid: start=' + start + ', end=' + end);
            }

            var p = sync.find('p');
            if (p.length == 0)
                p = sync;

            if (p.text().trim() != '&nbsp;') {
                fs.write(fd, j + '\n');
                fs.write(fd, formatTime(start + optTimeOffset) + ' --> ' + formatTime(end + optTimeOffset) + '\n');
                fs.write(fd, p.html().replace(/<br>\s*/g, '\n').trim() + '\n');
                fs.write(fd, '\n');
                j++;
            }
            else {
            }
        });

        fs.close(fd);
    }

    return 0;
}
else if (/^1\n/.test(text)) {
    var outputFile = optDest;

    if (!outputFile)
        outputFile = srcName + '.' + (srcLang || 'ko') + '.srt';

    if (argv.n) {
        if (fs.existsSync(outputFile)) {
            console.log("File exists:", path.basename(outputFile));
            return 0;
        }
    }

    console.log(outputFile);

    var fd = fs.openSync(outputFile, 'w');
    var j = 1;

    text = text.replace(/\n[ \t]+(?=\n)/g, '\n');
    text = text.replace(/\n(?=\n\n)/g, '');
    text = text.replace(/([^\n])(\n\d+\n\d\d:)/g, '$1\n$2');

    text.split('\n\n').map(function (ln) {
        if (ln.length > 0) {
            var nln = ln.replace(/(\d+)\n(\d\d):(\d\d):(\d\d),(\d\d\d) --> (\d\d):(\d\d):(\d\d),(\d\d\d)/,
                function(match, n, s1, s2, s3, s4, e1, e2, e3, e4) {
                    var start = 1000 * (60 * (60 * parseInt(s1) + parseInt(s2)) + parseInt(s3)) + parseInt(s4);
                    var end = 1000 * (60 * (60 * parseInt(e1) + parseInt(e2)) + parseInt(e3)) + parseInt(e4);

                    return formatTime(start + optTimeOffset) + ' --> ' + formatTime(end + optTimeOffset);
                });
            fs.write(fd, (j++) + '\n' + nln + '\n\n');
        }
    })

    fs.close(fd);

    return 0;
}
else {
    console.error("Unknown file format", [ text.charCodeAt(0), text.charCodeAt(1), text.charCodeAt(2) ]);

    return 1;
}

function formatTime(t) {
    return sprintf ("%02d:%02d:%02d,%03d", (t / 3600000), ((t / 60000)) % 60, ((t / 1000)) % 60, t % 1000);
}
