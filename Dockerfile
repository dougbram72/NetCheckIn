FROM node:24-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV HOST=0.0.0.0
ENV PORT=3100
ENV NETCHECKIN_PYTHON=python3

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip libsndfile1 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

RUN python3 -m pip install --no-cache-dir --break-system-packages \
  numpy soundfile torch torchaudio --index-url https://download.pytorch.org/whl/cpu

COPY . .

EXPOSE 3100

CMD ["npm", "start"]
