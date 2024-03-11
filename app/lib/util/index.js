const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { nip19 } = require('nostr-tools');
const ProcessStream = require('process-streams');


const formatPubkey = (pubkey) => {

	const npub = nip19.npubEncode(pubkey);
	
	return `${npub.slice(0, 9)}...${npub.slice(-4)}`;
};

const loadJson = (params) => {

	let object;

	try {

		const data = fs.readFileSync(params.path);

		object = JSON.parse(data.toString('utf8'));

	} catch (err) {
		console.log(err);
	}

	if (object) {

		return object;
	}
};

const saveJson = (data, params) => {

	try {

		fs.writeFileSync(
			params.path,
			Buffer.from(JSON.stringify(data))
		);

	} catch (err) {
		console.log(err);
	}

};

const writeJsonl = (jsonArray, params) => {

	return new Promise((resolve, reject) => {

		const filename = params.compress ? `${params.outputName}.temp.jsonl` : `${params.outputName}.jsonl`;
	  const writableStream = fs.createWriteStream(path.join(params.outputPath, filename));

	  const transform = new Transform({
	    transform: (json, encoding, callback) => {
	      callback(null, json);
	    }
	  });

	  const indexf = jsonArray.length - 1;

	  transform.pipe(writableStream);

	  jsonArray.forEach((item, index) => {
	    transform.write(JSON.stringify(item) + (index === indexf ? '' : '\n'));
	  });

	  transform.end();

	  writableStream.on('finish', async () => {

	  	console.log('got finish');

			if (params.compress) {

				const outputPath = path.join(params.outputPath, `${params.outputName}.jsonl.zst`);
				const inputPath = path.join(params.outputPath, filename);

				try {

					// Compress using ZSTD
					await CompressZSTD({
						level: params.compressionLevel,
						//binaryPath: '/Users/sbowman/Devops/repos/satellite-node/satellite-electron/bin/zstd',
						outputPath,
						inputPath
					});

					// Cleanup the temporary file
					fs.unlinkSync(inputPath);

					resolve();

				} catch (err) {
					console.log(err);
					reject(err);
				}

			} else {

				resolve();
			}

	  });

	  writableStream.on('error', err => {
	    reject(err);
	  });

	});
};

const CompressZSTD = (params) => {


	console.log('bin path', path.join(__dirname, 'bin/zstd'));


	return new Promise((resolve, reject) => {

		const ps = new ProcessStream();

		// Detect architecture to pass the correct native zstd module
		const cs = ps.spawn(
			path.join(__dirname, `bin/${process.arch === 'arm64' ? 'arm64' : 'x86'}/zstd`),
			[ `-${typeof params.level === 'undefined' ? 7 : params.level}` ]
		).on('exit', (code, signal) => {

			console.log('exit', code, signal);

			if (code !== 0) {

				reject();
			}
		});

		const output = fs.createWriteStream(params.outputPath);

		fs.createReadStream(params.inputPath).pipe(cs).pipe(output).on('error', (err) => {
			console.log(err);
			reject(err);
		}).on('finish', () => {
			console.log('compress finished!');
			resolve();
		});

	});
};

module.exports = {
	formatPubkey,
	loadJson,
	saveJson,
	writeJsonl
};
