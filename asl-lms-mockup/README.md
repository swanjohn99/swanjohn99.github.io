# SignPath public test-page deployment artifact

**Public preview:** https://www.hudsongetaways.com/asl-lms-mockup/

The canonical SignPath source code, smoke tests, GitHub Actions deployment workflow, and technical architecture are maintained in the **private** repository:

- https://github.com/swanjohn99/asllms
- Source: `asllms/index.html`
- Workflow: `asllms/.github/workflows/deploy-hudson.yml`

**Do not edit `index.html` here.** It is the **published copy** of the mockup. After `HUDSON_DEPLOY_TOKEN` is set in the source repo's Actions secrets, every push to the source `main` branch automatically validates and syncs only this published HTML file.

The first deployment was seeded using the connected GitHub integration; the website's existing GitHub Pages Actions pipeline serves this folder. The public preview contains fictional data and is **not a production LMS**.
