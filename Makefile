setup:
	npm install -g @vercel/ncc

build: src/index.js
	ncc build src/index.js
