export const ROUTING_HEAD_LIMITS = Object.freeze({
    dimension: 4096,
    rows: 8192,
    featureCells: 1_048_576,
    iterations: 2000,
    artifactBytes: 512 * 1024,
    numericMagnitude: 1e12,
});
function check(ok, message) {
    if (!ok)
        throw new TypeError(`Invalid routing head: ${message}`);
}
function record(value, keys, path) {
    check(value !== null && typeof value === "object", `${path} must be an object`);
    const prototype = Object.getPrototypeOf(value);
    check(prototype === Object.prototype || prototype === null, `${path} must be plain`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    check(Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key)), `${path} has unknown fields`);
    check(Object.values(descriptors).every((d) => "value" in d && d.enumerable), `${path} must contain enumerable data fields`);
    return value;
}
function number(value, path, min, max) {
    check(typeof value === "number" &&
        Number.isFinite(value) &&
        value >= min &&
        value <= max, `${path} is out of range`);
    return value;
}
function integer(value, path, min, max) {
    const result = number(value, path, min, max);
    check(Number.isSafeInteger(result), `${path} must be an integer`);
    return result;
}
function vector(value, length, path, min = -1e12, max = 1e12) {
    check(Array.isArray(value) &&
        Object.getPrototypeOf(value) === Array.prototype &&
        value.length === length, `${path} has wrong dimension`);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    check(Reflect.ownKeys(value).length === length + 1, `${path} must be a dense plain array`);
    return Array.from({ length }, (_, i) => {
        const descriptor = descriptors[String(i)];
        check(descriptor && "value" in descriptor && descriptor.enumerable, `${path}[${i}] must be a data field`);
        return number(descriptor.value, `${path}[${i}]`, min, max);
    });
}
function dot(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++)
        sum += a[i] * b[i];
    return sum;
}
function sigmoid(value) {
    if (value >= 0)
        return 1 / (1 + Math.exp(-value));
    const exponential = Math.exp(value);
    return exponential / (1 + exponential);
}
function infinityNorm(values) {
    return values.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
}
function close(a, b) {
    return Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b));
}
/** Validate JSON data and return an independent, deeply frozen artifact. */
export function validateRoutingHeadArtifact(input) {
    const a = record(input, [
        "version",
        "dimension",
        "weights",
        "bias",
        "featureCenter",
        "featureScale",
        "threshold",
        "minMargin",
        "calibration",
        "trainingDiagnostics",
    ], "artifact");
    check(a.version === 1 && a.calibration === "uncalibrated", "unsupported version or calibration");
    const dimension = integer(a.dimension, "dimension", 1, ROUTING_HEAD_LIMITS.dimension);
    const weights = vector(a.weights, dimension, "weights");
    const featureCenter = vector(a.featureCenter, dimension, "featureCenter");
    const featureScale = vector(a.featureScale, dimension, "featureScale", 1e-12, 2e12);
    const bias = number(a.bias, "bias", -1e12, 1e12);
    const threshold = number(a.threshold, "threshold", Number.EPSILON, 1 - Number.EPSILON);
    const minMargin = number(a.minMargin, "minMargin", 0, 2 * Math.min(threshold, 1 - threshold));
    const d = record(a.trainingDiagnostics, [
        "optimizer",
        "objective",
        "rowCount",
        "classCounts",
        "standardize",
        "l2",
        "maxIterations",
        "iterations",
        "initialLoss",
        "loss",
        "dataLoss",
        "regularizationLoss",
        "fullGradient",
        "gradientNorm",
        "gradientInfinityNorm",
        "stationarityTolerance",
        "stationary",
        "termination",
    ], "trainingDiagnostics");
    check(d.optimizer === "lbfgs" &&
        d.objective === "mean_logistic_loss_plus_l2_weights", "unsupported training objective");
    const rowCount = integer(d.rowCount, "rowCount", 2, ROUTING_HEAD_LIMITS.rows);
    check(rowCount * dimension <= ROUTING_HEAD_LIMITS.featureCells, "too many training feature cells");
    const counts = record(d.classCounts, ["fast", "strong"], "classCounts");
    const fast = integer(counts.fast, "classCounts.fast", 1, rowCount - 1);
    const strong = integer(counts.strong, "classCounts.strong", 1, rowCount - 1);
    check(fast + strong === rowCount, "class counts do not sum to rowCount");
    check(typeof d.standardize === "boolean", "standardize must be boolean");
    const l2 = number(d.l2, "l2", 1e-8, 1e6);
    const maxIterations = integer(d.maxIterations, "maxIterations", 1, ROUTING_HEAD_LIMITS.iterations);
    const iterations = integer(d.iterations, "iterations", 0, maxIterations);
    const initialLoss = number(d.initialLoss, "initialLoss", 0, 1e30);
    const loss = number(d.loss, "loss", 0, 1e30);
    const dataLoss = number(d.dataLoss, "dataLoss", 0, 1e30);
    const regularizationLoss = number(d.regularizationLoss, "regularizationLoss", 0, 1e30);
    check(close(loss, dataLoss + regularizationLoss), "loss components disagree");
    check(loss <= initialLoss || close(loss, initialLoss), "loss exceeds initialLoss");
    const fullGradient = vector(d.fullGradient, dimension + 1, "fullGradient", -1e30, 1e30);
    const gradientNorm = number(d.gradientNorm, "gradientNorm", 0, 1e30);
    const gradientInfinityNorm = number(d.gradientInfinityNorm, "gradientInfinityNorm", 0, 1e30);
    check(close(gradientNorm, Math.hypot(...fullGradient)) &&
        close(gradientInfinityNorm, infinityNorm(fullGradient)), "gradient norms disagree");
    const stationarityTolerance = number(d.stationarityTolerance, "stationarityTolerance", 1e-12, 1e-2);
    check(typeof d.stationary === "boolean" &&
        d.stationary === gradientInfinityNorm <= stationarityTolerance, "stationarity disagrees with full gradient");
    check(d.termination === "stationary" ||
        d.termination === "max_iterations" ||
        d.termination === "line_search_stalled", "invalid termination");
    check((d.termination === "stationary") === d.stationary, "termination disagrees with stationarity");
    check(d.termination !== "max_iterations" || iterations === maxIterations, "iteration limit was not reached");
    const artifact = {
        version: 1,
        dimension,
        weights: Object.freeze(weights),
        bias,
        featureCenter: Object.freeze(featureCenter),
        featureScale: Object.freeze(featureScale),
        threshold,
        minMargin,
        calibration: "uncalibrated",
        trainingDiagnostics: Object.freeze({
            optimizer: "lbfgs",
            objective: "mean_logistic_loss_plus_l2_weights",
            rowCount,
            classCounts: Object.freeze({ fast, strong }),
            standardize: d.standardize,
            l2,
            maxIterations,
            iterations,
            initialLoss,
            loss,
            dataLoss,
            regularizationLoss,
            fullGradient: Object.freeze(fullGradient),
            gradientNorm,
            gradientInfinityNorm,
            stationarityTolerance,
            stationary: d.stationary,
            termination: d.termination,
        }),
    };
    check(new TextEncoder().encode(JSON.stringify(artifact)).length <=
        ROUTING_HEAD_LIMITS.artifactBytes, "artifact exceeds byte limit");
    return Object.freeze(artifact);
}
/** Fit only supplied rows. No model, tokenizer, filesystem, or network is used. */
export function fitRoutingHead(rows, options = {}) {
    check(Array.isArray(rows) &&
        rows.length >= 2 &&
        rows.length <= ROUTING_HEAD_LIMITS.rows, "expected 2–8192 training rows");
    const first = record(rows[0], ["id", "features", "label"], "row[0]");
    check(Array.isArray(first.features), "row[0].features must be an array");
    const dimension = integer(first.features.length, "dimension", 1, ROUTING_HEAD_LIMITS.dimension);
    check(rows.length * dimension <= ROUTING_HEAD_LIMITS.featureCells, "too many training feature cells");
    const ids = new Set();
    const ordered = rows
        .map((row, i) => {
        const value = record(row, ["id", "features", "label"], `row[${i}]`);
        check(typeof value.id === "string" &&
            value.id.length > 0 &&
            value.id.length <= 256 &&
            !ids.has(value.id), "row IDs must be nonempty and unique");
        ids.add(value.id);
        check(value.label === "fast" || value.label === "strong", `row[${i}].label is invalid`);
        return {
            id: value.id,
            features: vector(value.features, dimension, `row[${i}].features`),
            label: value.label,
        };
    })
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const strong = ordered.filter((row) => row.label === "strong").length;
    const fast = ordered.length - strong;
    check(fast > 0 && strong > 0, "both fast and strong training labels are required");
    const o = record(options, [
        "l2",
        "maxIterations",
        "tolerance",
        "standardize",
        "threshold",
        "minMargin",
    ], "options");
    const l2 = number(o.l2 === undefined ? 0.1 : o.l2, "l2", 1e-8, 1e6);
    const maxIterations = integer(o.maxIterations === undefined ? 300 : o.maxIterations, "maxIterations", 1, ROUTING_HEAD_LIMITS.iterations);
    const tolerance = number(o.tolerance === undefined ? 1e-7 : o.tolerance, "tolerance", 1e-12, 1e-2);
    const standardize = o.standardize === undefined ? true : o.standardize;
    check(typeof standardize === "boolean", "standardize must be boolean");
    const threshold = number(o.threshold === undefined ? 0.5 : o.threshold, "threshold", Number.EPSILON, 1 - Number.EPSILON);
    const minMargin = number(o.minMargin === undefined ? 0.1 : o.minMargin, "minMargin", 0, 2 * Math.min(threshold, 1 - threshold));
    const featureCenter = new Array(dimension).fill(0);
    const featureScale = new Array(dimension).fill(1);
    if (standardize) {
        for (let i = 0; i < ordered.length; i++)
            for (let j = 0; j < dimension; j++)
                featureCenter[j] +=
                    (ordered[i].features[j] - featureCenter[j]) / (i + 1);
        const variance = new Array(dimension).fill(0);
        for (const row of ordered)
            for (let j = 0; j < dimension; j++)
                variance[j] +=
                    (row.features[j] - featureCenter[j]) ** 2 / ordered.length;
        for (let j = 0; j < dimension; j++) {
            const deviation = Math.sqrt(variance[j]);
            featureScale[j] = deviation >= 1e-12 ? deviation : 1;
        }
    }
    const features = ordered.map((row) => row.features.map((value, j) => (value - featureCenter[j]) / featureScale[j]));
    const targets = ordered.map((row) => (row.label === "strong" ? 1 : 0));
    const objective = (parameters) => {
        const gradient = new Array(dimension + 1).fill(0);
        let dataLoss = 0;
        for (let i = 0; i < features.length; i++) {
            let logit = parameters[dimension];
            for (let j = 0; j < dimension; j++)
                logit += parameters[j] * features[i][j];
            // Stable binary cross entropy, without cancellation for a correct large logit.
            dataLoss +=
                (Math.max(targets[i] ? -logit : logit, 0) +
                    Math.log1p(Math.exp(-Math.abs(logit)))) /
                    features.length;
            const residual = (sigmoid(logit) - targets[i]) / features.length;
            for (let j = 0; j < dimension; j++)
                gradient[j] += residual * features[i][j];
            gradient[dimension] += residual;
        }
        let regularizationLoss = 0;
        for (let j = 0; j < dimension; j++) {
            regularizationLoss += (l2 * parameters[j] ** 2) / 2;
            gradient[j] += l2 * parameters[j];
        }
        return {
            loss: dataLoss + regularizationLoss,
            dataLoss,
            regularizationLoss,
            gradient,
        };
    };
    let parameters = new Array(dimension + 1).fill(0);
    parameters[dimension] = Math.log(strong / fast);
    let current = objective(parameters);
    const initialLoss = current.loss;
    const history = [];
    let iterations = 0;
    let stalled = false;
    while (iterations < maxIterations &&
        infinityNorm(current.gradient) > tolerance) {
        const direction = [...current.gradient];
        const alpha = new Array(history.length);
        for (let i = history.length - 1; i >= 0; i--) {
            alpha[i] = history[i].rho * dot(history[i].s, direction);
            for (let j = 0; j < direction.length; j++)
                direction[j] -= alpha[i] * history[i].y[j];
        }
        const last = history.at(-1);
        const gamma = last ? dot(last.s, last.y) / dot(last.y, last.y) : 1;
        for (let j = 0; j < direction.length; j++)
            direction[j] *= gamma;
        for (let i = 0; i < history.length; i++) {
            const beta = history[i].rho * dot(history[i].y, direction);
            for (let j = 0; j < direction.length; j++)
                direction[j] += history[i].s[j] * (alpha[i] - beta);
        }
        for (let j = 0; j < direction.length; j++)
            direction[j] = -direction[j];
        let slope = dot(current.gradient, direction);
        if (!Number.isFinite(slope) || slope >= 0) {
            history.length = 0;
            for (let j = 0; j < direction.length; j++)
                direction[j] = -current.gradient[j];
            slope = -dot(current.gradient, current.gradient);
        }
        let accepted;
        let step = 1;
        for (let backtrack = 0; backtrack < 50; backtrack++, step /= 2) {
            const candidate = parameters.map((value, j) => value + step * direction[j]);
            if (!candidate.every((value) => Number.isFinite(value) && Math.abs(value) <= 1e12))
                continue;
            const result = objective(candidate);
            if (Number.isFinite(result.loss) &&
                result.loss <= current.loss + 1e-4 * step * slope) {
                accepted = { parameters: candidate, result };
                break;
            }
        }
        if (!accepted) {
            stalled = true;
            break;
        }
        const s = accepted.parameters.map((value, j) => value - parameters[j]);
        const y = accepted.result.gradient.map((value, j) => value - current.gradient[j]);
        const curvature = dot(s, y);
        if (curvature > 0 && Number.isFinite(1 / curvature)) {
            history.push({ s, y, rho: 1 / curvature });
            if (history.length > 8)
                history.shift();
        }
        parameters = accepted.parameters;
        current = accepted.result;
        iterations++;
    }
    const gradientInfinityNorm = infinityNorm(current.gradient);
    const stationary = gradientInfinityNorm <= tolerance;
    return validateRoutingHeadArtifact({
        version: 1,
        dimension,
        weights: parameters.slice(0, dimension),
        bias: parameters[dimension],
        featureCenter,
        featureScale,
        threshold,
        minMargin,
        calibration: "uncalibrated",
        trainingDiagnostics: {
            optimizer: "lbfgs",
            objective: "mean_logistic_loss_plus_l2_weights",
            rowCount: ordered.length,
            classCounts: { fast, strong },
            standardize,
            l2,
            maxIterations,
            iterations,
            initialLoss,
            loss: current.loss,
            dataLoss: current.dataLoss,
            regularizationLoss: current.regularizationLoss,
            fullGradient: current.gradient,
            gradientNorm: Math.hypot(...current.gradient),
            gradientInfinityNorm,
            stationarityTolerance: tolerance,
            stationary,
            termination: stationary
                ? "stationary"
                : stalled
                    ? "line_search_stalled"
                    : "max_iterations",
        },
    });
}
/** Scores use persisted normalization; equal scores and cutoff boundaries abstain. */
export function scoreRoutingHead(artifact, features) {
    const head = validateRoutingHeadArtifact(artifact);
    const values = vector(features, head.dimension, "features");
    let logit = head.bias;
    for (let j = 0; j < head.dimension; j++)
        logit +=
            head.weights[j] *
                ((values[j] - head.featureCenter[j]) / head.featureScale[j]);
    const strongScore = sigmoid(logit);
    const fastScore = 1 - strongScore;
    const decision = fastScore === strongScore ||
        Math.abs(strongScore - head.threshold) <= head.minMargin / 2
        ? "uncertain"
        : strongScore > head.threshold
            ? "strong"
            : "fast";
    return { fastScore, strongScore, decision };
}
