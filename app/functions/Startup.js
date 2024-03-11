
module.exports = (app) => {

	const events = app.database.queryEvents([{
		kinds: [ 0, 3 ]
	}]);

	for (let event of events) {

		app.graph.add(event);
	}

	// Set initial stats for the database
	app.control.updateDatabaseStatus();
};
