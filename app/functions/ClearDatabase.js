
module.exports = (app) => {

	app.database.clear();

	app.control.updateDatabaseStatus();
};
