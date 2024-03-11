const OS = require('os');

const Functions = require('../functions');


module.exports = (control) => {

	return {

		CLEAR_DATABASE: () => {

			Functions.ClearDatabase(control.app);

			control.log({
				text: `[control] DATABASE CLEARED`
			});

		},

		EXPORT_DATABASE: async (params) => {

			let log;

			try {

				const t0 = Date.now();

				// KEEP WORKING . . . fix this hardcoded export path . . . make
				// a dialog in the ui that let's the user choose the export location


				await Functions.ExportDatabase(control.app, {
					filters: [{}],
					name: `events`,
					path: OS.homedir()
				});

				log = `[control] DATABASE EXPORT SUCCEEDED IN ${Date.now() - t0} MS`;

			} catch (err) {
				console.log(err);
				log = '[control] DATABASE EXPORT FAILED';
			}

			control.log({ text: log });
		},

		SYNC: (data) => {

			// dispatch([{
			// 	type: 'config/set',
			// 	data: control.config
			// }, {
			// 	type: 'status/set',
			// 	data: {
			// 		...control.status,
			// 		synced: true
			// 	}
			// }]);

			// console.log('control.app', control.app);
			// console.log('control', control);

			control.broadcast([{
				type: 'config/set',
				data: control.config
			}, {
				type: 'status/set',
				data: {
					...control.status,
					synced: true
				}
			}]);

			control.log({
				text: '[control] SATELLITE NODE CONNECTION ESTABLISHED',
			});
		},

		// Set node config and return updated props
		SET_CONFIG: (data) => {

			control.setConfig(data);
		},

		RECEIVER_CONFIG: (data) => {

			// Modify receiver config
			control.setConfig(data);

			// Restart the receiver is listening,
			// restart it to reflect new config
			if (control.status.listening) {

				Functions.StopReceiver(control.app, data);

				Functions.StartReceiver(control.app, data);
			}
		},

		RECEIVER_LISTEN: async (data) => {

			await Functions.StartReceiver(control.app, data);
		},

		RECEIVER_UNLISTEN: (data) => {

			Functions.StopReceiver(control.app, data);
		}
	};
};
