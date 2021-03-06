'use strict';

/* eslint-env node, es6 */

/* eslint-disable global-require */

const fs = require('fs');
const path = require('path');

const chalk = require('chalk');

const cosi = require(path.resolve(path.resolve(__dirname, '..', '..', '..', 'cosi')));
const Registration = require(path.resolve(cosi.lib_dir, 'registration'));
const Checks = require(path.resolve(cosi.lib_dir, 'registration', 'checks'));
// const Template = require(path.join(cosi.lib_dir, 'template'));
const templateList = require(path.join(cosi.lib_dir, 'template', 'list'));
const Dashboard = require(path.resolve(cosi.lib_dir, 'dashboard'));
const Graph = require(path.resolve(cosi.lib_dir, 'graph'));
const api = require(path.resolve(cosi.lib_dir, 'api'));

class Dashboards extends Registration {

    constructor(quiet) {
        super(quiet);

        const err = this.loadRegConfig();

        if (err !== null) {
            this.emit('error', err);
            return;
        }

        this.templates = null;
        this.graphs = null;
        this.checksMeta = null;
        this.metrics = null;
    }

    create(cb) {
        console.log(chalk.bold('\nRegistration - dashboards'));

        const self = this;

        this.once('checks.load', () => {
            console.log(chalk.blue(this.marker));
            console.log('Loading check meta data');

            const checks = new Checks();

            self.checkMeta = checks.getMeta();
            if (self.checkMeta === null) {
                self.emit('error', new Error('Unable to load check meta data'));
                return;
            }
            console.log(chalk.green('Loaded'), 'check meta data');
            self.emit('templates.find');
        });

        this.once('templates.find', this.findTemplates);
        this.once('templates.find.done', () => {
            if (self.templates.length === 0) {
                console.log(chalk.yellow('WARN'), 'No dashboard templates found');
                console.log(chalk.green('\nSKIPPING'), 'dasbhoards, none found to register');
                self.emit('dashboards.done');
                return;
            }
            self.emit('metrics.load');
        });

        this.once('metrics.load', this.loadMetrics);
        this.once('metrics.load.done', () => {
            self.emit('graphs.load');
        });

        this.once('graphs.load', this.loadGraphs);
        this.once('graphs.load.done', () => {
            self.emit('dashboards.config');
        });

        this.once('dashboards.config', this.configDashboards);
        this.once('dashboards.config.done', () => {
            self.emit('dashboards.create');
        });

        this.once('dashboards.create', this.createDashboards);
        this.once('dashboards.create.done', () => {
            self.emit('dashboards.finalize');
        });

        this.once('dashboards.finalize', () => {
            // noop at this point
            self.emit('dashboards.done');
        });

        this.once('dashboards.done', () => {
            if (typeof cb === 'function') {
                cb();
                return;
            }
        });

        this.emit('checks.load');
    }

    findTemplates() {
        console.log(chalk.blue(this.marker));
        console.log('Identifying dashboard templates');

        const self = this;

        templateList(cosi.reg_dir, (listError, templates) => {
            if (listError) {
                self.emit('error', listError);
                return;
            }

            self.templates = [];

            // for (const template of templates) {
            for (let i = 0; i < templates.length; i++) {
                const template = templates[i];
                const templateType = template.config.type;
                const templateId = template.config.id;

                if (templateType !== 'dashboard') {
                    continue;
                }

                console.log(`\tFound ${templateType}-${templateId} ${template.file}`);
                self.templates.push(template);
            }

            console.log(chalk.green('Loaded'), `${this.templates.length} template(s)`);
            self.emit('templates.find.done');
        });
    }


    loadGraphs() {
        console.log(chalk.blue(this.marker));
        console.log('Loading graphs');

        this.graphs = [];

        const fileList = fs.readdirSync(cosi.reg_dir);

        for (let i = 0; i < fileList.length; i++) {
            const file = fileList[i];

            if (file.match(/^registration-graph-/)) {
                console.log(`\tExtracting meta data from ${file}`);
                const graphCfgFile = path.resolve(path.join(cosi.reg_dir, file));
                const graph = new Graph(graphCfgFile);

                this.graphs.push({
                    instance_name: path.basename(file, '.json').replace(/^registration-graph-/, ''),
                    tags: graph.tags.join(','),
                    id: graph._cid.replace('/graph/', '')
                });
            }
        }

        if (this.graphs === null || this.graphs.length === 0) {
            this.emit('error', new Error('Unable to load meta data for graphs'));
            return;
        }

        console.log(chalk.green('Loaded'), `meta data from ${this.graphs.length} graphs`);
        this.emit('graphs.load.done');
    }


    configDashboards() {
        const self = this;
        const dashboards = this.templates;

        console.log(chalk.bold(`Configuring dasbhoards`), `for ${this.templates.length} template(s)`);

        this.on('config.dashboard.next', () => {
            const template = dashboards.shift();

            if (typeof template === 'undefined') {
                self.emit('dashboards.config.done');
                return;
            }

            self.configDashboard(template);
            self.emit('config.dashboard.next');
        });

        this.emit('config.dashboard.next');
    }


    configDashboard(template) { // eslint-disable-line complexity
        console.log(chalk.blue(this.marker));
        console.log(`Configuring dasbhoard`);

        const templateMatch = template.file.match(/^template-dashboard-([^\-]+)-(.+)\.json$/);

        if (templateMatch === null) {
            this.emit('error', new Error(`Invalid template, no instance found. ${template.file}`));
            return;
        }

        const dashboardID = `${templateMatch[1]}-${templateMatch[2]}`;
        const dashboardInstance = templateMatch[2];
        const templateFile = path.resolve(path.join(cosi.reg_dir, template.file));
        const configFile = templateFile.replace('template-', 'config-');

        console.log(`\tDashboard: ${dashboardID} (${templateFile})`);

        if (this._fileExists(configFile)) {
            console.log(chalk.bold('\tConfiguration exists'), `- using ${configFile}`);
            this.emit('config.dashboard.next');
            return;
        }

        const metaFile = path.resolve(path.join(cosi.reg_dir, `meta-dashboard-${dashboardID}.json`));
        let metaData = { sys_graphs: [] };

        console.log(`\tUsing meta data from ${metaFile}`);

        if (this._fileExists(metaFile)) {
            try {
                metaData = require(metaFile);
                if (!{}.hasOwnProperty.call(metaData, 'sys_graphs')) {
                    metaData.sys_graphs = [];
                }
            } catch (err) {
                if (err.code !== 'MODULE_NOT_FOUND') {
                    this.emit('error', err);
                    return;
                }
            }
        }

        for (let i = 0; i < metaData.sys_graphs.length; i++) {
            metaData.sys_graphs[i].instance_name = [
                metaData.sys_graphs[i].metric_group,
                metaData.sys_graphs[i].graph_instance === null ? 0 : metaData.sys_graphs[i].graph_instance,
                metaData.sys_graphs[i].metric_item
            ].join('-');
        }

        const config = JSON.parse(JSON.stringify(template.config.config));
        let data = null;

        data = this._mergeData(`dashboard-${dashboardID}`);
        data.dashboard_instance = dashboardInstance;
        if ({}.hasOwnProperty.call(metaData, 'vars')) {
            for (const dataVar in metaData.vars) { // eslint-disable-line guard-for-in
                data[dataVar] = metaData.vars[dataVar];
            }
        }

        console.log(`\tInterpolating title ${config.title}`);
        config.title = this._expand(config.title, data);

        console.log(`\tConfiguring graph widgets`);
        for (let i = config.widgets.length - 1; i >= 0; i--) {
            const widget = config.widgets[i];

            if (widget.type !== 'graph') {
                continue;
            }

            const graphIdx = this._findWidgetGraph(widget, metaData);

            if (graphIdx === -1) {
                console.log(chalk.yellow('\tWARN'), 'No graph found for', widget.widget_id, 'with tag', widget.tags);
                continue;
            }
            widget.settings.account_id = this.regConfig.account.account_id;
            widget.settings.graph_id = this.graphs[graphIdx].id;
            widget.settings.label = this._expand(widget.settings.label, data);
            delete widget.tags; // tags property used to match graphs, remove before submission
        }

        console.log(`\tConfiguring gauge widgets`);
        for (let i = config.widgets.length - 1; i >= 0; i--) {
            const widget = config.widgets[i];

            if (widget.type !== 'gauge') {
                continue;
            }

            const metric_name = this._expand(widget.settings.metric_name, data);
            const metricParts = metric_name.match(/^([^`]+)`(.*)$/);
            let foundMetric = false;

            if (metricParts === null) {
                foundMetric = {}.hasOwnProperty.call(this.metrics, metric_name);
            } else {
                const metricGroup = metricParts[1];
                const metricName = metricParts[2];

                if ({}.hasOwnProperty.call(this.metrics, metricGroup)) {
                    foundMetric = {}.hasOwnProperty.call(this.metrics[metricGroup], metricName);
                }
            }

            if (foundMetric) {
                widget.settings.metric_name = metric_name;
                widget.settings.account_id = this.regConfig.account.account_id;
                widget.settings.check_uuid = this.checkMeta.system.uuid;
            } else {
                console.log(chalk.yellow('\tWARN'), 'No metric found for widget', widget.widget_id, 'matching', metric_name);
            }
        }


        console.log(`\tConfiguring forecast widgets`);
        for (let i = config.widgets.length - 1; i >= 0; i--) {
            const widget = config.widgets[i];

            if (widget.type !== 'forecast') {
                continue;
            }

            if (!{}.hasOwnProperty.call(widget.settings, 'metrics')) {
                console.log(`\t\tNo metrics attribute in widget '${widget.settings.title}', skipping.`);
                continue;
            }

            if (!Array.isArray(widget.settings.metrics) || widget.settings.metrics.length === 0) {
                console.log(`\t\t0 metrics defined for widget '${widget.settings.title}', skipping.`);
                continue;
            }

            const forecast_metrics = [];

            for (const metric of widget.settings.metrics) {
                const metric_name = this._expand(metric, data);
                const metricParts = metric_name.match(/^([^`]+)`(.*)$/);
                let foundMetric = false;

                if (metricParts === null) {
                    foundMetric = {}.hasOwnProperty.call(this.metrics, metric_name);
                } else {
                    const metricGroup = metricParts[1];
                    const metricName = metricParts[2];

                    if ({}.hasOwnProperty.call(this.metrics, metricGroup)) {
                        foundMetric = {}.hasOwnProperty.call(this.metrics[metricGroup], metricName);
                    }
                }

                if (foundMetric) {
                    forecast_metrics.push({
                        check_uuid: this.checkMeta.system.uuid,
                        metric_name
                    });
                }
            }

            if (widget.settings.metrics.length !== forecast_metrics.length) {
                console.log(`\t\tMetric count error, only found ${forecast_metrics.length} of ${widget.settings.metrics.length}`);
                continue;
            }

            const forecastData = JSON.parse(JSON.stringify(data));

            widget.settings.title = this._expand(widget.settings.title, data);
            forecastData.forecast_metrics = forecast_metrics;
            widget.settings.resource_limit = this._expand(widget.settings.resource_limit, forecastData);
            widget.settings.resource_usage = this._expand(widget.settings.resource_usage, forecastData);
            delete widget.settings.metrics;
            console.log(`\t\tConfigured forecast widget '${widget.settings.title}'`);

        }


        console.log(`\tPurging unconfigured widgets`);
        for (let i = config.widgets.length - 1; i >= 0; i--) {
            let removeWidget = false;

            if (config.widgets[i].type === 'graph') {
                removeWidget = config.widgets[i].settings.graph_id === null;
            } else if (config.widgets[i].type === 'gauge') {
                removeWidget = config.widgets[i].settings.check_uuid === null;
            } else if (config.widgets[i].type === 'forecast') {
                removeWidget = {}.hasOwnProperty.call(config.widgets[i].settings, 'metrics');
            } else {
                console.log(chalk.yellow('\tWARN'), `Unsupported widget type (${config.widgets[i].type}), ignoring widget id:${config.widgets[i].widget_id}`);
            }

            if (removeWidget) {
                console.log(chalk.yellow('\tWARN'), `Removing widget from dashboard (id ${config.widgets[i].widget_id})`);
                config.widgets.splice(i, 1);
            }
        }

        if (config.widgets.length === 0) {
            console.log(chalk.red('ERROR'), 'No applicable widgets were configured with available metrics/graphs...');
            this.emit('error', new Error('No widgets configured on dashboard'));
            return;
        }

        try {
            fs.writeFileSync(configFile, JSON.stringify(config, null, 4), { encoding: 'utf8', mode: 0o644, flag: 'w' });
        } catch (err) {
            this.emit('error', err);
            return;
        }

        console.log('\tSaved configuration', configFile);
    }


    createDashboards() {
        const self = this;
        const dashboardConfigs = [];

        try {
            const files = fs.readdirSync(cosi.reg_dir);

            for (let i = 0; i < files.length; i++) {
                const file = files[i];

                if (file.match(/^config-dashboard-/)) {
                    dashboardConfigs.push(path.resolve(path.join(cosi.reg_dir, file)));
                }
            }
        } catch (err) {
            this.emit('error', err);

            return;
        }

        this.on('create.dashboard.next', () => {
            const configFile = dashboardConfigs.shift();

            if (typeof configFile === 'undefined') {
                self.emit('dashboards.create.done');
                return;
            }

            self.createDashboard(configFile);
        });

        this.emit('create.dashboard.next');
    }

    createDashboard(cfgFile) {
        console.log(chalk.blue(this.marker));
        console.log('Creating dashboard', cfgFile);

        const regFile = cfgFile.replace('config-', 'registration-');

        if (this._fileExists(regFile)) {
            console.log(chalk.bold('\tRegistration exists'), `- using ${regFile}`);
            this.emit('create.dashboard.next');
            return;
        }

        if (!this._fileExists(cfgFile)) {
            this.emit('error', new Error(`Missing dashboard configuration file '${cfgFile}'`));
            return;
        }

        const dashboard = new Dashboard(cfgFile);

        if (dashboard.verifyConfig()) {
            console.log('\tValid dashboard config');
        }

        console.log('\tSending dashboard configuration to Circonus API');

        const self = this;

        this._findDashboard(dashboard.title, (findErr, regConfig) => {
            if (findErr !== null) {
                self.emit('error', findErr);
                return;
            }

            if (regConfig !== null) {
                console.log(`\tSaving registration ${regFile}`);
                try {
                    fs.writeFileSync(regFile, JSON.stringify(regConfig, null, 4), { encoding: 'utf8', mode: 0o644, flag: 'w' });
                } catch (saveErr) {
                    self.emit('error', saveErr);
                    return;
                }

                console.log(chalk.green('\tDashboard:'), `${self.regConfig.account.ui_url}/dashboards/view/${dashboard._dashboard_uuid}`);
                self.emit('create.dashboard.next');
                return;
            }

            console.log('\tSending dashboard configuration to Circonus API');

            dashboard.create((err) => {
                if (err) {
                    self.emit('error', err);
                    return;
                }

                console.log(`\tSaving registration ${regFile}`);
                dashboard.save(regFile, true);

                console.log(chalk.green('\tDashboard created:'), `${self.regConfig.account.ui_url}/dashboards/view/${dashboard._dashboard_uuid}`);
                self.emit('create.dashboard.next');
            });
        });
    }


    finalizeDashboards() {
        // noop at this point
        this.emit('dashboards.finalize.done');
    }


    /*

    Utility methods

    */

    _findDashboard(title, cb) {
        if (title === null) {
            cb(new Error('Invalid dashboard title'));
            return;
        }

        console.log(`\tChecking API for existing dashboard with title '${title}'`);

        api.setup(cosi.api_key, cosi.api_app, cosi.api_url);
        api.get('/dashboard', { f_title: title }, (code, errAPI, result) => {
            if (errAPI) {
                const apiError = new Error();

                apiError.code = 'CIRCONUS_API_ERROR';
                apiError.message = errAPI;
                apiError.details = result;
                cb(apiError);
                return;
            }

            if (code !== 200) {
                const errResp = new Error();

                errResp.code = code;
                errResp.message = 'UNEXPECTED_API_RETURN';
                errResp.details = result;
                cb(errResp);
                return;
            }

            if (Array.isArray(result) && result.length > 0) {
                console.log(chalk.green('\tFound'), `${result.length} existing dashboard(s) with title '${title}'`);
                cb(null, result[0]);
                return;
            }

            cb(null, null);
        });
    }


    _findWidgetGraph(widget, metaData) {
        for (let graphIdx = 0; graphIdx < this.graphs.length; graphIdx++) {
            for (let j = 0; j < widget.tags.length; j++) {
                if (this.graphs[graphIdx].tags.indexOf(widget.tags[j]) !== -1) {
                    return graphIdx;
                }
                for (let sgIdx = 0; sgIdx < metaData.sys_graphs.length; sgIdx++) {
                    if (metaData.sys_graphs[sgIdx].dashboard_tag === widget.tags[j]) {
                        if (this.graphs[graphIdx].instance_name === metaData.sys_graphs[sgIdx].instance_name) {
                            return graphIdx;
                        }
                    }
                }
            }
        }
        return -1;
    }

}

module.exports = Dashboards;
