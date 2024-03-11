
module.exports = (app) => {

	console.log('node shutting down gracefully...');

	app.control.stop();

	app.receiver.stop();

	app.database.stop();

	app.relay.stop();

	//process.exit(0);
};
