import { useEffect } from 'react'
import { BenchView } from './bench'
import { CityView } from './pages/CityView'
import { Home } from './pages/Home'
import { Progress } from './pages/Progress'
import { MotionSync } from './panels/SettingsMenu'
import { useRoute } from './router'
import { useCity } from './store'

export default function App() {
  const route = useRoute()
  const bench = /^#\/bench\/(\d+)/.exec(window.location.hash)
  useEffect(() => {
    if (route.page !== 'city') useCity.getState().reset()
  }, [route.page])
  return (
    <>
      <MotionSync />
      {bench ? (
        <BenchView n={Number(bench[1])} />
      ) : route.page === 'city' ? (
        <CityView key={route.id} id={route.id} />
      ) : route.page === 'analyze' ? (
        <Progress key={route.id} id={route.id} />
      ) : (
        <Home />
      )}
    </>
  )
}
