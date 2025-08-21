// Shared types for frames and detections

export type FrameMetadata = {
	frameId: number; // monotonically increasing id from sender
	captureTs: number; // performance.now() at capture time on sender
};

export type Detection = {
	label: string;
	score: number; // 0..1
	xmin: number; // normalized 0..1
	ymin: number; // normalized 0..1
	xmax: number; // normalized 0..1
	ymax: number; // normalized 0..1
};

export type InferenceResult = {
	frameId: number;
	recvTs?: number;
	inferenceTs?: number;
	detections: Detection[];
};


