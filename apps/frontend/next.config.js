/**
 * Next.js config for WebRTC VLM with ONNX Runtime WebAssembly support
 */
const nextConfig = {
	reactStrictMode: true,
	
	// WebAssembly support
	webpack: (config, { isServer }) => {
		// Handle WebAssembly files
		config.experiments = {
			...config.experiments,
			asyncWebAssembly: true,
		};
		
		// Handle ONNX Runtime files
		config.module.rules.push({
			test: /\.wasm$/,
			type: 'asset/resource',
		});
		
		// Handle ONNX Runtime JavaScript files
		config.module.rules.push({
			test: /\.m?js$/,
			resolve: {
				fullySpecified: false,
			},
		});
		
		// Fallback for Node.js modules
		config.resolve.fallback = {
			...config.resolve.fallback,
			fs: false,
			path: false,
			crypto: false,
		};
		
		return config;
	},
	
	// Disable static optimization for dynamic imports
	experimental: {
		esmExternals: 'loose',
	},
};

module.exports = nextConfig;


