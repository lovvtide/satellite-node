module.exports = (app, data) => {

	// Listen if not already
	if (!app.control.status.listening) {

		const status = { listening: true };

		// Report status to gui
		app.control.setStatus(status);

		// await receiver.listen(control.config);
		app.receiver.listen(app.control.config);

		// Report status to parent process
		app.control.sendToParentProcess({
			type: 'LISTENER_STATE',
			data: status
		});

		app.control.log({
			text: '[CONTROL] SATELLITE RECEIVER LISTENING'
		});
	}
};
