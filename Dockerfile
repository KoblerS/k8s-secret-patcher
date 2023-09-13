FROM node:lts-alpine3.13

# Create application directory
WORKDIR /usr/src/app

COPY . /usr/src/app

CMD ["npm", "start"]
