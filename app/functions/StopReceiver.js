module.exports = (app, data) => {

	// Unlisten if listening
	if (app.control.status.listening) {

		const status = { listening: false };

		// Report status to gui
		app.control.setStatus(status);

		app.receiver.unlisten();

		// Report status to parent process
		app.control.sendToParentProcess({
			type: 'LISTENER_STATE',
			data: status
		});

		app.control.log({
			text: '[CONTROL] SATELLITE RECEIVER PAUSED'
		});
	}
};
